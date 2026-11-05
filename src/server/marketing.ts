import "server-only";
import { nanoid } from "nanoid";
import { z } from "zod";
import { getModel, supportsOp } from "@/lib/catalog";
import { lengthRange, plannedDurations } from "@/lib/catalog/clip-lengths";
import {
  AD_STYLES,
  brandLine,
  CLICK_TO_AD,
  cueLines,
  END_CARD,
  endCardSteps,
  estimateCues,
  fitScript,
  FORMATS,
  formatModels,
  hookById,
  MARKETING_IMAGE_MODEL,
  MAX_PROMPT,
  mentionsFor,
  MULTIPLIER,
  MULTIPLIER_MODELS,
  MULTIPLIER_WINDOW,
  multiplierResolution,
  OPEN_SOUND_JOIN,
  overlayLayout,
  pickable,
  multiplierText,
  settingById,
  shotPlan,
  snapDuration,
  styleById,
  TEMPLATE_INDEX,
  isCodeTemplate,
  UGC_MODELS,
  wordBudget,
  wordsOnTop,
  type BrandKit,
  type FormatDef,
  type FormatId,
  type MarketingRun,
  type MarketingRunMeta,
  type MarketingTemplate,
  type PlannedStep,
  type Product,
  type RunEstimate,
  type RunFeature,
  type RunOverlay,
} from "@/lib/catalog/marketing";
import { dualEngine } from "@/lib/catalog/engines";
import { routesFor } from "@/lib/catalog/plan";
import { themeFrom, type AdLayout } from "@/components/ads/layout";
import { adDraft } from "@/lib/layout-surfaces";
import { LAYOUT_PARAM } from "@/lib/layout-prompt";
import { END_CARD_VARIANTS } from "@/lib/motion/scenes/end-card/shared";
import type { ChainSlot, Engine, GenerationRequest, ModelDef, Operation } from "@/lib/catalog/types";
import { getBrand, getProduct } from "./brand";
import { createPipeline, type PipelineStep } from "./chains";
import { db } from "./db";
import { llmText } from "./enhance";
import { createGenerations, getGeneration, listGenerations, previewChained, recordLocalGeneration } from "./generations";
import { isOffered } from "./model-access";
import { keepOffered } from "@/lib/model-access";
import { engineMode } from "./settings";
import { encodePng } from "./png";
import { localHead, saveFile, storedMedia } from "./storage";
import { imageSize } from "@/lib/image-size";
import { targetShortEdge } from "@/lib/av/upscale";
import { isH3Graph } from "@/lib/h3-prompt";

/**
 * Marketing Studio (templates → product shots, posters, ads, product motion, UGC presenters),
 * Click to Ad (product link → 9:16 voiced ad) and Ad Multiplier (a reference ad → new versions).
 * Every run is one batch of generations — single requests, or chained steps through createPipeline —
 * recorded in marketing_runs with what made it (template, product, script, the text the browser sets
 * over open-engine posters). Both engines; demo mode runs every step on the mock provider.
 */

const FILE = z.string().startsWith("/api/files/").max(500);

// ---------------------------------------------------------------------------
// Inputs

export const MarketingBody = z.object({
  engine: z.enum(["cloud", "open"]),
  format: z.enum(["product-standalone", "product-with-model", "motion-2d", "motion-hyper", "motion-mixed", "motion-saas", "ugc-talking", "tiktok", "ads", "poster", "marketplace"]),
  templateId: z.string().max(80).optional(),
  modelId: z.string().max(80).optional(),
  productId: z.string().max(40).optional(),
  /** Product pictures (uploaded, or the product's own; the first is the hero). */
  productImages: z.array(FILE).max(6).optional(),
  avatar: FILE.optional(),
  reference: FILE.optional(),
  brandId: z.string().max(40).optional(),
  hookId: z.string().max(40).nullish(),
  settingId: z.string().max(40).nullish(),
  prompt: z.string().max(MAX_PROMPT).optional(),
  headline: z.string().max(140).optional(),
  cta: z.string().max(40).optional(),
  aspectRatio: z.string().max(8).optional(),
  duration: z.number().min(3).max(30).optional(),
  batch: z.number().int().min(1).max(4).optional(),
  voice: z.string().max(80).optional(),
  voiceSample: FILE.optional(),
  script: z.string().max(2000).optional(),
  website: z.string().max(300).optional(),
  /** "Words drawn by the model" (formats with words): the headline and button drawn in place from a layout. */
  drawnWords: z.boolean().optional(),
});
export type MarketingInput = z.infer<typeof MarketingBody>;

export const ClickToAdBody = z.object({
  engine: z.enum(["cloud", "open"]),
  productId: z.string().max(40),
  styleId: z.string().max(40),
  /** Pictures to use (3 by default; drag to reorder in the kit). */
  images: z.array(FILE).max(5).optional(),
  presenter: z.boolean().optional(),
  script: z.string().max(1200).optional(),
  /** Custom-script instructions ("highlight free shipping"). */
  instructions: z.string().max(600).optional(),
  quality: z.enum(["480p", "720p"]).optional(),
  voice: z.string().max(80).optional(),
  voiceSample: FILE.optional(),
  avatar: FILE.optional(),
  /**
   * End on the brand: a logo card after the ad, held 2–3 s. `image` is the card the page drew (brand colour,
   * logo, product name, CTA); without it the cloud puts the kit's logo on its main colour (the open engine needs it).
   * `clip`: the card animated in the page (Kinetic Motion), joined as it is; `variant` names its style (a note only).
   */
  endCard: z
    .object({
      image: FILE.optional(),
      clip: FILE.optional(),
      seconds: z.number().min(END_CARD.minSeconds).max(END_CARD.maxSeconds).optional(),
      variant: z.enum(END_CARD_VARIANTS).optional(),
    })
    .optional(),
});
export type ClickToAdInput = z.infer<typeof ClickToAdBody>;

export const MultiplierBody = z.object({
  engine: z.enum(["cloud", "open"]),
  video: FILE,
  /** The clip's length (read in the browser), for the 4–30 s rule and the price. */
  duration: z.number().min(0.5).max(600),
  start: z.number().min(0).optional(),
  end: z.number().min(0).optional(),
  images: z.array(FILE).max(MULTIPLIER.maxImages).optional(),
  mode: z.enum(["prompt", "sections"]),
  prompt: z.string().max(MULTIPLIER.maxChars).optional(),
  hook: z.string().max(MULTIPLIER.maxChars).nullish(),
  cta: z.string().max(MULTIPLIER.maxChars).nullish(),
  quality: z.enum(MULTIPLIER.qualities),
  modelId: z.string().max(80).optional(),
  /** Frames grabbed in the browser at the in and out points (hook / CTA mode). */
  firstFrame: FILE.optional(),
  lastFrame: FILE.optional(),
  versions: z.number().int().min(1).max(4).optional(),
});
export type MultiplierInput = z.infer<typeof MultiplierBody>;

// ---------------------------------------------------------------------------
// Plans: steps with labels, before anything is created

interface Step {
  key: string;
  label: string;
  request: GenerationRequest;
  after?: string[];
  chain?: ChainSlot[];
}

export interface RunPlan {
  feature: RunFeature;
  engine: Engine;
  title: string;
  steps: Step[];
  /** Keys of the result steps. */
  finals: string[];
  meta: MarketingRunMeta;
  notes: string[];
}

export class PlanError extends Error {}

const need = (model: string): ModelDef => {
  const m = getModel(model);
  if (!m) throw new PlanError(`Unknown model ${model}`);
  return m;
};

/** Qwen-Image 2.1's expand graph on your GPU: it grows a photo to the ad's shape before a clip starts on it. */
export const FIT_PHOTO_MODEL = "oss-qwen-image-21";
const FIT_PHOTO_PROMPT = "Continue the scene naturally beyond every edge with matching perspective, lighting, textures and grain.";

/** A clip model that makes its clip in the start frame's own shape: MiniMax H3 on your GPU (its i2v graph runs at "auto"). */
const keepsFrameShape = (clip: ModelDef) => clip.engine === "open" && clip.routes.some((r) => r.op === "i2v" && isH3Graph(r.endpoint));

/** Margins (multiples of 8 px) that grow a width × height picture to the aspect ratio; null when it's already that shape. */
export function padsTo(size: { width: number; height: number }, aspect: string): { padLeft: number; padTop: number; padRight: number; padBottom: number } | null {
  const [a, b] = aspect.split(":").map(Number);
  if (!(a > 0 && b > 0)) return null;
  const want = a / b;
  const have = size.width / size.height;
  if (Math.abs(have - want) / want < 0.02) return null;
  const side = (total: number) => Math.round(total / 2 / 8) * 8;
  if (have < want) {
    const x = side(size.height * want - size.width);
    return x > 0 ? { padLeft: x, padTop: 0, padRight: x, padBottom: 0 } : null;
  }
  const y = side(size.width / want - size.height);
  return y > 0 ? { padLeft: 0, padTop: y, padRight: 0, padBottom: y } : null;
}

/**
 * The start frame of a clip made from a photo. MiniMax H3 on your GPU keeps its start frame's shape, so a photo of
 * another shape (a square product photo in a 9:16 ad) is first grown to the ad's shape on Qwen-Image 2.1 (a step
 * added to `steps`, once per photo), and the clip starts on that picture. Any other clip model, a photo already in
 * shape, or one whose size can't be read starts on the photo itself.
 */
function startFrame(steps: Step[], photo: string, aspect: string | undefined, clip: ModelDef, feature: string): Pick<GenerationRequest, "inputs" | "chain"> & { after?: string[] } {
  const own = { inputs: { images: [photo] } };
  if (!aspect || !keepsFrameShape(clip) || !getModel(FIT_PHOTO_MODEL)) return own;
  const head = localHead(photo);
  const size = head ? imageSize(head) : null;
  const pads = size ? padsTo(size, aspect) : null;
  if (!pads) return own;
  let fit = steps.find((s) => s.request.modelId === FIT_PHOTO_MODEL && s.request.op === "outpaint" && s.request.inputs?.images?.[0] === photo);
  if (!fit) {
    const n = steps.filter((s) => s.key.startsWith("fit")).length + 1;
    fit = {
      key: `fit${n}`,
      label: n > 1 ? `Photo ${n} in ${aspect}` : `Photo in ${aspect}`,
      request: { feature, modelId: FIT_PHOTO_MODEL, op: "outpaint", prompt: FIT_PHOTO_PROMPT, inputs: { images: [photo] }, params: { extra: pads } },
    };
    steps.push(fit);
  }
  return { chain: [{ slot: "images", position: "first" }], after: [fit.key] };
}

/** The model's own aspect ratio closest to the wanted one ("auto" when it takes it, else by shape). */
export function nearestAspect(want: string | undefined, allowed: string[] | undefined): string | undefined {
  if (!want || !allowed?.length || allowed.includes(want)) return want;
  const ratio = (s: string) => {
    const [a, b] = s.split(":").map(Number);
    return a && b ? a / b : NaN;
  };
  const r = ratio(want);
  if (!Number.isFinite(r)) return allowed[0];
  return [...allowed].filter((a) => Number.isFinite(ratio(a))).sort((a, b) => Math.abs(Math.log(ratio(a) / r)) - Math.abs(Math.log(ratio(b) / r)))[0];
}

const isSvg = (u?: string) => !!u && /\.svg(\?|$)/i.test(u);
const sentence = (s?: string) => (s ? s.trim().replace(/[.\s]+$/, "") : "");
const join = (...parts: (string | false | 0 | undefined | null)[]) =>
  parts
    .map((p) => (p ? sentence(p) : ""))
    .filter(Boolean)
    .join(". ") + ".";

const fill = (s: string, product?: Product | null, brand?: BrandKit | null) =>
  s.replace(/\{product\}/g, product?.name ?? "it").replace(/\{brand\}/g, brand?.name ?? product?.name ?? "").trim();

function productLine(p?: Product | null): string {
  if (!p) return "";
  const pts = p.sellingPoints.slice(0, 2).join("; ");
  const about = p.description?.replace(/\s+/g, " ").trim().slice(0, 160);
  return `The product is ${p.name}${about ? ` — ${about}` : ""}${pts ? ` (${pts})` : ""}`;
}

const KEEP_PRODUCT = "Keep the product exactly as in the reference photo: its shape, proportions, label, logo, text and colours";

/** The picture the browser sets the words over: the scene and the subject alone (the product keeps its own label). */
const CLEAN_PICTURE = "A clean, uncluttered picture of the scene and the subject alone";

/**
 * The exact headline/CTA in a prompt (cloud partner models render text), or room left for the browser to set it (open
 * models and Fuobe Marketing Image on either engine: wordsOnTop).
 */
function textLine(f: FormatDef, onTop: boolean, headline?: string, cta?: string, brand?: BrandKit | null): string {
  if (!f.text) return "";
  // The words are set in the browser, in the layout overlayLayout() picks: the picture leaves room for them.
  if (onTop)
    return overlayLayout(f.id) === "frame"
      ? `${CLEAN_PICTURE}; the subject well composed with a little breathing room at the edges`
      : `${CLEAN_PICTURE}, with calm, uncluttered space in the lower third for the headline`;
  const font = brand?.fonts.heading ? `set in a ${brand.fonts.heading}-style typeface` : "in bold, clean typography";
  const lettering = headline && cta ? "the headline and the button are the only added lettering" : headline ? "the headline is the only added lettering" : "the button is the only added lettering";
  return [headline && `The headline reads exactly “${headline}” ${font}`, cta && `a button that says exactly “${cta}”`, (headline || cta) && `${lettering}, every word spelled exactly as written`].filter(Boolean).join(", ");
}

export interface PlanContext {
  product?: Product | null;
  brand?: BrandKit | null;
  /** The words the presenter says (UGC). */
  script?: string;
}

/** Templates drawn in the browser (exact words in the brand's fonts) never go to a model. */
export const CODE_TEMPLATE_REFUSAL = "This template is made in your browser: open it in Marketing Studio";

/** Marketing Studio: one run of a template (images) or a pipeline (motion over several shots, UGC). */
export function planMarketing(input: MarketingInput, ctx: PlanContext): RunPlan {
  const f = FORMATS[input.format as FormatId];
  const tpl: MarketingTemplate | undefined = input.templateId ? TEMPLATE_INDEX.get(input.templateId) : undefined;
  if (input.templateId && !tpl) throw new PlanError("This preset is no longer available.");
  if (tpl && isCodeTemplate(tpl)) throw new PlanError(CODE_TEMPLATE_REFUSAL);
  if (tpl && tpl.format !== f.id) throw new PlanError("That template belongs to another format");
  const open = input.engine === "open";
  const product = ctx.product ?? null;
  const brand = f.brandKit ? (ctx.brand ?? null) : null;
  const productImages = input.productImages?.length ? input.productImages : (product?.images ?? []);
  const hasProduct = productImages.length > 0;
  const prompt = input.prompt?.trim() ?? "";
  const website = input.website?.trim() || brand?.website || "";
  // Required inputs, in Higgsfield's words.
  if (f.product === "required" && !hasProduct) throw new PlanError(product ? `${product.name} has no images` : "Attach a product to generate");
  if (f.oneOf?.length) {
    const has = { product: hasProduct, avatar: !!input.avatar, prompt: !!prompt, website: !!website };
    if (!f.oneOf.some((k) => has[k])) {
      throw new PlanError(f.id === "product-with-model" ? "Attach reference or product" : f.id === "poster" ? "Add a prompt or a product" : "Add a prompt, a product or a website");
    }
  }
  // Models switched off in Settings → Models & licences aren't picked while another choice is on.
  // "Words drawn by the model": only where the format has words, on a picture.
  const drawn = !!input.drawnWords && !!f.text && f.pipeline === "image";
  const listed = formatModels(f, input.engine, { product: hasProduct, avatar: !!input.avatar }, drawn);
  // A choice listed only to say it runs on your GPU (the Original's Standalone shot in the cloud) is refused in its words.
  const elsewhere = listed.find((c) => c.unavailable && c.id === input.modelId);
  if (elsewhere) throw new PlanError(`${need(elsewhere.id).name} makes ${f.name} shots on your GPU only (${elsewhere.unavailable}): switch to your GPU, or pick another model`);
  const choices = keepOffered(pickable(listed), (c) => isOffered(c.id, input.engine));
  const name = tpl?.name ?? f.name;
  const title = [name, product?.name ?? brand?.name].filter(Boolean).join(" · ");
  const meta: MarketingRunMeta = { format: f.id, templateId: tpl?.id, productId: product?.id ?? null, brandId: brand?.id ?? null };
  const notes: string[] = [];
  const brandText = brandLine(brand);
  const feature = "marketing";

  if (f.pipeline === "image") {
    const modelId = input.modelId && choices.some((c) => c.id === input.modelId) ? input.modelId : choices[0].id;
    const model = need(modelId);
    const onTop = wordsOnTop(input.engine, modelId, drawn);
    const refs = [
      ...(f.product !== "none" ? productImages.slice(0, 1) : []),
      ...(input.avatar && f.avatar !== "none" ? [input.avatar] : []),
      ...(input.reference ? [input.reference] : []),
      // The logo as a reference lets a partner model draw it; otherwise it is set on top in the browser.
      ...(!onTop && !drawn && f.text && brand?.logo && !isSvg(brand.logo) ? [brand.logo] : []),
    ];
    const max = model.options.maxImages ?? (supportsOp(model, "edit") ? 1 : 0);
    let images = refs.slice(0, Math.max(0, max));
    if (images.length < refs.length) notes.push(`${model.name} takes ${max} reference image${max === 1 ? "" : "s"}; the rest are left out`);
    let op: Operation = images.length && supportsOp(model, "edit") ? "edit" : "t2i";
    if (op === "t2i" && !supportsOp(model, "t2i")) {
      if (!images.length) throw new PlanError(`${model.name} needs a product photo`);
      op = "edit";
    }
    if (op === "t2i") images = [];
    // Words drawn by the model: the brand's own logo goes after the photos to a model with room for it, so the layout's
    // logo box is the real logo (a model that draws from words alone gets no logo box: it would make one up).
    const drawnLogo = drawn && op === "edit" && images.length > 0 && images.length < max ? rasterLogo(brand) : undefined;
    if (drawnLogo) images = [...images, drawnLogo];
    const headline = input.headline?.trim() || (tpl?.headline ? fill(tpl.headline, product, brand) : "");
    const cta = input.cta?.trim() || (tpl?.cta ? fill(tpl.cta, product, brand) : "");
    const person = input.avatar ? "the person from the reference photo (same face, hair, skin tone and build)" : "a natural-looking model who suits the product";
    const scene = tpl ? fill(tpl.prompt, product, brand) : "";
    const text = join(
      f.id === "product-with-model"
        ? `Photograph of ${person} with the product`
        : f.id === "poster"
          ? "A designed poster"
          : f.id === "marketplace"
            ? "A marketplace listing image for an online store"
            : f.id === "ads"
              ? "A finished social media ad"
              : "Commercial product photograph",
      scene,
      productLine(product),
      hasProduct && op === "edit" && KEEP_PRODUCT,
      drawnLogo && "The last reference image is the brand's logo: place it as it is, in its box",
      input.reference && "Use the last reference photo for the setting and light",
      prompt,
      // Drawn words come from the layout's text boxes, in their places.
      !drawn && textLine(f, onTop, headline, cta, brand),
      brandText,
    );
    // bria-product-shot and Product Photography take the scene alone.
    const scenePrompt = modelId === "bria-product-shot" ? join(scene || "A clean studio scene", prompt, brand?.aesthetics.slice(0, 2).join(", ")) : text;
    const palette = !open && brand?.colors.length && routesFor(model, op).some((r) => r.map?.palette) ? brand.colors.slice(0, 5) : undefined;
    const aspect = nearestAspect(input.aspectRatio ?? tpl?.aspect ?? f.defaultAspect, model.options.aspectRatios);
    meta.overlay = onTop && f.text && (headline || cta) ? { headline: headline || undefined, cta: cta || undefined } : null;
    // Words set in the browser go on one picture per run: a batch is that many runs (runsFor), each composed.
    const batch = meta.overlay ? 1 : Math.min(input.batch ?? 1, f.batch);
    // The copy's places as the browser would set them (frame for posters, overlay for the rest), drawn by the model.
    const layout =
      drawn && (headline || cta)
        ? adDraft({
            ratio: aspect ?? f.defaultAspect,
            layout: overlayLayout(f.id) as AdLayout,
            content: { headline, cta: cta || undefined },
            brand,
            mode: "words",
            logo: !!drawnLogo,
            product: product ? `${product.name}${product.description ? `, ${product.description.replace(/\s+/g, " ").trim().slice(0, 160)}` : ""}` : scene || prompt || "The subject of the picture",
            caption: "",
            meta: [f.id === "poster" ? "poster" : "advertising", "graphic design"],
          })
        : undefined;
    if (drawn && !layout) notes.push("Add a headline or a button to have them drawn in place");
    if (layout) notes.push(`${model.name} draws your headline and button in their places, so the lettering is the model's, not your brand fonts`);
    if (layout && hasProduct && op === "t2i") notes.push(`${model.name} draws your product from its name and description, not from your photo`);
    if (onTop && f.text) notes.push("Your headline is set over the picture in your brand fonts, so the words come out exact");
    // On the user's GPU a Standalone shot of one product photo is cut out and relit into the scene (White_to_Scene).
    const productShot = open && modelId === MARKETING_IMAGE_MODEL && f.id === "product-standalone" && op === "edit" && images.length === 1;
    if (productShot) notes.push("Your product is cut out and relit into the scene, so it stays as it is");
    else if (open && op === "edit") notes.push("Qwen-Image 2.1 keeps your first photo's shape on your GPU");
    return {
      feature,
      engine: input.engine,
      title,
      steps: [
        {
          key: "image",
          label: name,
          request: {
            feature,
            modelId,
            // Fuobe Marketing Image runs on both engines: the studio's engine picks its half.
            ...(dualEngine(model) && { engine: input.engine }),
            op,
            prompt: model.options.promptless ? undefined : scenePrompt.slice(0, MAX_PROMPT),
            inputs: images.length ? { images } : undefined,
            params: { aspectRatio: aspect, numOutputs: batch, ...(palette && { palette }), ...((productShot || layout) && { extra: { ...(productShot && { productShot: true }), ...(layout && { [LAYOUT_PARAM]: layout }) } }) },
            title,
            batchTitle: title,
          },
        },
      ],
      finals: ["image"],
      meta,
      notes,
    };
  }

  if (f.pipeline === "motion") {
    const modelId = input.modelId && choices.some((c) => c.id === input.modelId) ? input.modelId : choices[0].id;
    const model = need(modelId);
    const want = input.duration ?? tpl?.duration ?? f.durations!.default;
    const aspect = nearestAspect(input.aspectRatio ?? f.defaultAspect, model.options.aspectRatios);
    const refs = [...productImages.slice(0, 1), ...(input.reference ? [input.reference] : [])];
    const motionText = (extra?: string) =>
      join(tpl ? fill(tpl.prompt, product, brand) : "A polished product commercial", extra, productLine(product), hasProduct && "The product stays exactly as in the first frame: same shape, label and colours", prompt, brandText, !hasProduct && website && `For the product at ${website}`);
    const base = { feature, modelId, params: { aspectRatio: aspect } as GenerationRequest["params"] };
    // Open models make a few seconds per clip: longer motion is several shots from the product photo, joined. MiniMax H3
    // on your GPU renders any length from 3 to 15 s in one clip.
    const range = open ? lengthRange(model) : undefined;
    const shots = range && want <= range[1] ? [Math.max(range[0], Math.round(want))] : open ? shotPlan(want, plannedDurations(model)) : [snapDuration(want, model.options.durations)];
    if (shots.length === 1 && shots[0] !== want) notes.push(`${model.name} makes ${shots[0]} s clips — the closest to ${want} s`);
    const op: Operation = refs.length > 1 && supportsOp(model, "ref2v") ? "ref2v" : refs.length ? "i2v" : "t2v";
    if (op === "t2v" && !supportsOp(model, "t2v")) throw new PlanError("Attach a product to generate");
    const VARIATIONS = ["Wide establishing shot that introduces the product", "Slow push-in to a close-up of the product's details", "Graceful orbit around the product that ends on its hero angle", "Macro detail pass over the texture and label"];
    // MiniMax H3 on your GPU keeps the photo's shape: a photo of another shape is grown to the format's first.
    const steps: Step[] = [];
    const { after: frameAfter, ...frame } = op === "i2v" ? startFrame(steps, refs[0], aspect, model, `${feature}-step`) : { after: undefined };
    if (frameAfter) notes.push(`${model.name} keeps its first frame's shape: the photo is grown to ${aspect} on Qwen-Image 2.1 first`);
    steps.push(
      ...shots.map(
        (d, i): Step => ({
          key: `shot${i + 1}`,
          label: shots.length > 1 ? `Shot ${i + 1} of ${shots.length}` : name,
          request: {
            ...base,
            feature: shots.length > 1 ? `${feature}-step` : feature,
            op,
            prompt: motionText(shots.length > 1 ? VARIATIONS[i % VARIATIONS.length] : undefined).slice(0, MAX_PROMPT),
            ...(op === "i2v" ? frame : { inputs: op === "t2v" ? undefined : { images: refs } }),
            params: { ...base.params, duration: d, ...(model.options.audio && { generateAudio: true }) },
            title,
          },
          ...(frameAfter && { after: frameAfter }),
        }),
      ),
    );
    if (shots.length > 1) {
      const joiner = UGC_MODELS[input.engine].join;
      steps.push({
        key: "film",
        label: `${name} · ${shots.length} shots`,
        request: { feature, modelId: joiner, op: "concat", prompt: title, params: { aspectRatio: nearestAspect(aspect, need(joiner).options.aspectRatios) }, chain: shots.map(() => ({ slot: "videos" as const })), title, batchTitle: title },
        after: shots.map((_, i) => `shot${i + 1}`),
      });
      notes.push(`${model.name} makes up to ${Math.max(...(plannedDurations(model) ?? [5]))} s per clip: ${shots.length} shots from your product photo, joined`);
    }
    return { feature, engine: input.engine, title, steps, finals: [steps[steps.length - 1].key], meta, notes };
  }

  // UGC / TikTok: voice → presenter still → talking clip → captions (+ hook clip, product close-up) → join.
  return planPresenter({
    feature,
    engine: input.engine,
    title,
    meta,
    script: ctx.script ?? "",
    product,
    productImages,
    brand,
    avatar: input.avatar,
    reference: input.reference,
    aspect: input.aspectRatio ?? f.defaultAspect,
    hook: f.hookAndSetting ? hookById(input.hookId === undefined ? tpl?.hook : input.hookId) : undefined,
    setting: f.hookAndSetting ? settingById(input.settingId === undefined ? tpl?.setting : input.settingId) : undefined,
    look: tpl ? fill(tpl.prompt, product, brand) : undefined,
    voice: input.voice,
    voiceSample: input.voiceSample,
    talkModel: !open && input.modelId && choices.some((c) => c.id === input.modelId) ? input.modelId : undefined,
    broll: hasProduct,
    notes,
  });
}

interface PresenterPlan {
  feature: RunFeature;
  engine: Engine;
  title: string;
  meta: MarketingRunMeta;
  script: string;
  product: Product | null;
  productImages: string[];
  brand: BrandKit | null;
  avatar?: string;
  reference?: string;
  aspect: string;
  hook?: ReturnType<typeof hookById>;
  setting?: ReturnType<typeof settingById>;
  look?: string;
  voice?: string;
  voiceSample?: string;
  talkModel?: string;
  /** A product close-up after the presenter. */
  broll: boolean;
  /** Seconds of product close-up (Click to Ad keeps the ad ≤ 12 s). */
  brollSeconds?: number;
  quality?: string;
  notes: string[];
}

/** A talking presenter with the product: the shared UGC chain (Marketing Studio UGC/TikTok, Click to Ad). */
function planPresenter(p: PresenterPlan): RunPlan {
  const open = p.engine === "open";
  const M = UGC_MODELS[p.engine];
  const step = `${p.feature}-step`;
  if (!p.script.trim()) throw new PlanError("Write the script first");
  if (open && !p.voiceSample) throw new PlanError("Add a voice sample — open-source voices are cloned from a short recording");
  const seconds = p.script.split(/\s+/).filter(Boolean).length / 2.5;
  const talkId = p.talkModel ?? (open ? (seconds > 6.5 ? "oss-infinitetalk-long" : M.talk) : M.talk);
  const talk = need(talkId);
  const clip = need(M.clip);
  const aspect = nearestAspect(p.aspect, talk.options.aspectRatios) ?? p.aspect;
  const refs = [...(p.avatar ? [p.avatar] : []), ...p.productImages.slice(0, 1), ...(p.reference ? [p.reference] : [])].slice(0, need(M.still).options.maxImages ?? 3);
  // Reference photos go to the edit model; without any the presenter is drawn from the words.
  const stillModel = need(refs.length ? M.still : M.stillFromWords);
  const person = p.avatar ? "the person from the first reference photo (same face, hair and skin tone)" : "a friendly, relatable creator in their twenties";
  const holding = p.productImages.length ? `holding the product from the ${p.avatar ? "second reference photo" : "reference photo"} up near their face` : "talking to the camera";
  const where = p.setting?.prompt ?? "at home in natural light";
  const steps: Step[] = [
    {
      key: "voice",
      label: "Voiceover",
      request: {
        feature: step,
        modelId: M.voice,
        op: "tts",
        prompt: p.script,
        inputs: open ? { voiceAudio: p.voiceSample } : undefined,
        params: !open && p.voice ? { voice: p.voice } : undefined,
      },
    },
    {
      key: "still",
      label: "Presenter",
      request: {
        feature: step,
        modelId: stillModel.id,
        op: refs.length ? "edit" : "t2i",
        prompt: join(
          `A vertical smartphone selfie video frame of ${person} ${holding}, ${where}`,
          p.look,
          p.productImages.length && KEEP_PRODUCT,
          "Authentic UGC look, natural light, eye contact with the camera, mouth relaxed and closed, ready to speak",
          p.brand && brandLine(p.brand),
        ),
        inputs: refs.length ? { images: refs } : undefined,
        params: { aspectRatio: nearestAspect(aspect, stillModel.options.aspectRatios) ?? aspect, numOutputs: 1 },
      },
    },
    {
      key: "talk",
      label: "Talking",
      request: { feature: step, modelId: talkId, op: "avatar", prompt: "Natural talking presenter, small hand gestures, looks into the camera", params: { aspectRatio: aspect, ...(p.quality && { resolution: p.quality }) } },
      after: ["still", "voice"],
      chain: [{ slot: "images" }, { slot: "audio" }],
    },
    {
      key: "captions",
      label: "Captions",
      request: open
        ? { feature: step, modelId: M.captions, op: "captions", prompt: cueLines(estimateCues(p.script)) }
        : { feature: step, modelId: M.captions, op: "captions", params: languageCode(p.brand?.language) ? { sourceLanguage: languageCode(p.brand?.language) } : undefined },
      after: ["talk"],
      chain: [{ slot: "video" }],
    },
  ];
  const clipLen = (want: number) => snapDuration(want, plannedDurations(clip));
  const clips: string[] = [];
  if (p.hook) {
    steps.push({
      key: "hook",
      label: `Hook · ${p.hook.name}`,
      request: {
        feature: step,
        modelId: M.clip,
        op: "i2v",
        prompt: join(p.hook.prompt, "Same person, outfit and setting as the frame", "Vertical handheld phone footage, energetic UGC style"),
        params: { aspectRatio: nearestAspect(aspect, clip.options.aspectRatios), duration: clipLen(4), ...(clip.options.audio && { generateAudio: true }), ...(p.quality && { resolution: p.quality }) },
        chain: [{ slot: "images", position: "first" }],
      },
      after: ["still"],
    });
    clips.push("hook");
  }
  clips.push("captions");
  if (p.broll && p.productImages.length) {
    const { after: frameAfter, ...frame } = startFrame(steps, p.productImages[0], nearestAspect(aspect, clip.options.aspectRatios), clip, step);
    steps.push({
      ...(frameAfter && { after: frameAfter }),
      key: "broll",
      label: "Product close-up",
      request: {
        feature: step,
        modelId: M.clip,
        op: "i2v",
        prompt: join("Handheld close-up of the product turning slowly in soft natural light, shallow depth of field", KEEP_PRODUCT),
        ...frame,
        params: { aspectRatio: nearestAspect(aspect, clip.options.aspectRatios), duration: clipLen(p.brollSeconds ?? 4), ...(clip.options.audio && { generateAudio: false }), ...(p.quality && { resolution: p.quality }) },
      },
    });
    clips.push("broll");
  }
  if (clips.length > 1) {
    // The open join keeps one clip's own sound: the captioned presenter's voice, after the hook when there is one
    // (oss-join-clips drops every soundtrack and plays the 25 fps presenter at the hook's 16 fps).
    const joinId = open ? (p.hook ? OPEN_SOUND_JOIN.second : OPEN_SOUND_JOIN.first) : M.join;
    const joiner = need(joinId);
    steps.push({
      key: "film",
      label: "Final video",
      request: {
        feature: p.feature,
        modelId: joinId,
        op: "concat",
        prompt: p.title,
        params: { aspectRatio: nearestAspect(aspect, joiner.options.aspectRatios), ...(open && { resolution: nearestRes(p.quality ?? "480p", joiner) }) },
        chain: clips.map(() => ({ slot: "videos" as const })),
        title: p.title,
        batchTitle: p.title,
      },
      after: clips,
    });
  } else {
    const c = steps.find((s) => s.key === "captions")!;
    c.request = { ...c.request, feature: p.feature, title: p.title, batchTitle: p.title };
  }
  if (open) p.notes.push("Open captions are timed from the script at a natural speaking pace");
  p.meta.script = p.script;
  return { feature: p.feature, engine: p.engine, title: p.title, steps, finals: [steps[steps.length - 1].key === "film" ? "film" : "captions"], meta: p.meta, notes: p.notes };
}

// ---------------------------------------------------------------------------
// Scripts

const SCRIPT_SYSTEM = `You write short spoken scripts for vertical video ads (TikTok, Reels, Shorts).
Write ONLY the words the presenter says out loud: no stage directions, no scene notes, no emojis, no hashtags, no quotation marks, no labels.
Sound like a real person talking to a friend, open with a hook in the first line, end with a short call to action.`;

export interface ScriptInput {
  product?: Product | null;
  brand?: BrandKit | null;
  seconds: number;
  hook?: string;
  angle?: string;
  style?: string;
  instructions?: string;
  language?: string;
}

const countWords = (t: string) => t.split(/\s+/).filter(Boolean).length;
const capitalize = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** Words that tell the writer what to do ("mention", "highlight…"), dropped when the line is spoken as is. */
const DIRECTIVE = String.raw`(?:mention|highlight|say|talk about|focus on|emphasi[sz]e|include|add|stress|call out|point out|note|tell (?:them|people|viewers))`;

/**
 * Custom-script instructions as lines the presenter can say: "highlight eco-friendly materials,
 * mention free shipping over $40" → ["Eco-friendly materials.", "Free shipping over $40."].
 */
export function spokenInstructions(text: string | undefined): string[] {
  if (!text?.trim()) return [];
  return text
    .split(new RegExp(String.raw`[;\n]+|,\s*(?:and\s+)?(?=${DIRECTIVE}\b)|\s+and\s+(?=${DIRECTIVE}\b)`, "i"))
    .map((part) =>
      part
        .trim()
        .replace(new RegExp(String.raw`^(?:please\s+)?(?:(?:make sure|be sure) (?:to|you)\s+)?${DIRECTIVE}(?:\s+that)?\s+`, "i"), "")
        .replace(/[.!?,;:\s]+$/, ""),
    )
    .filter(Boolean)
    .map((part) => `${capitalize(part)}.`);
}

/**
 * A natural script from facts alone, for installs with no LLM, built to the word budget by priority:
 * the call to action and the instructions always stay, the opener shortens, and selling points fill
 * what's left — the middle gives way, never the end.
 */
export function heuristicScript(s: ScriptInput): string {
  const budget = wordBudget(s.seconds);
  const name = s.product?.name ?? s.brand?.name ?? "this";
  const found = [...(s.product?.sellingPoints ?? []), ...(s.brand?.sellingPoints ?? [])].map(sentence).filter(Boolean);
  const points = (found.length ? found : ["It just works, it looks great, and it makes my day a little easier"]).slice(0, 2).map((p) => `${capitalize(p)}.`);
  // Longest first; the last of each list is the shortest form.
  const openers = s.hook
    ? [`Okay, that was not how I planned to start this, but I have to tell you about ${name}.`, `Okay, I have to tell you about ${name}.`, `Meet ${name}.`]
    : [`I didn't expect ${name} to become part of my every day, but here we are.`, `I didn't expect to love ${name} this much.`, `Meet ${name}.`];
  const closes = s.brand?.website ? [`Go check out ${s.brand.name} — link's in my bio.`, "Link's in my bio."] : ["Honestly? Go try it for yourself.", "Go try it today."];
  let instructions = spokenInstructions(s.instructions);
  let opener = openers[openers.length - 1];
  let close = closes[closes.length - 1];
  const used = () => countWords([opener, ...instructions, close].join(" "));
  if (used() > budget) {
    // Instructions longer than the ad: keep their first words, still ending on the call to action.
    const room = Math.max(1, budget - countWords(opener) - countWords(close));
    const words = instructions.join(" ").split(/\s+/).slice(0, room).join(" ").replace(/[,;:.!?\s]+$/, "");
    instructions = words ? [`${words}.`] : [];
    if (used() > budget) opener = "";
  }
  close = closes.find((c) => countWords([opener, ...instructions, c].join(" ")) <= budget) ?? close;
  if (opener) opener = openers.find((o) => countWords([o, ...instructions, close].join(" ")) <= budget) ?? opener;
  const middle: string[] = [];
  for (const p of points) if (countWords([opener, ...instructions, ...middle, p, close].join(" ")) <= budget) middle.push(p);
  return [opener, ...instructions, ...middle, close].filter(Boolean).join(" ");
}

/** The words the presenter says: the LLM when one is set up, else the heuristic. Always within the word budget. */
export async function writeScript(s: ScriptInput): Promise<{ script: string; by: "llm" | "rules" }> {
  const words = wordBudget(s.seconds);
  const user = [
    `Length: about ${words} words (${Math.round(s.seconds)} seconds spoken).`,
    s.product && `Product: ${s.product.name}${s.product.description ? ` — ${s.product.description.slice(0, 500)}` : ""}`,
    s.product?.sellingPoints.length && `Selling points: ${s.product.sellingPoints.join("; ")}`,
    s.product?.audience && `Audience: ${s.product.audience}`,
    s.brand && `Brand: ${s.brand.name}${s.brand.tagline ? ` — ${s.brand.tagline}` : ""}. Tone: ${s.brand.tone.join(", ") || "friendly"}.`,
    s.angle && `Format: ${s.angle}`,
    s.hook && `Opening hook (what happens on screen): ${s.hook}`,
    s.style && `Delivery: ${s.style}`,
    s.instructions && `Instructions: ${s.instructions}`,
    `Language: ${s.language ?? s.brand?.language ?? "English"}`,
  ]
    .filter(Boolean)
    .join("\n");
  const out = await llmText(SCRIPT_SYSTEM, user);
  const cleaned = out
    ?.replace(/^\s*(script|presenter|voiceover|narrator)\s*:\s*/i, "")
    .replace(/\[[^\]]*\]|\([^)]*\)/g, "")
    .replace(/["“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned && cleaned.split(" ").length >= 5 ? { script: fitScript(cleaned, s.seconds), by: "llm" } : { script: heuristicScript(s), by: "rules" };
}

// ---------------------------------------------------------------------------
// Click to Ad: product link → product kit → style → 9:16 voiced ad (≤ 12 s)

/** Seconds of voice that fit the ad: the presenter talks, then a product close-up ends it. */
export function clickToAdSeconds(engine: Engine, presenter: boolean): { voice: number; broll: number } {
  const clip = need(UGC_MODELS[engine].clip);
  // The close-up is the clip model's length nearest 4 s (5 s on MiniMax H3); the voice gets the rest of the 12 s.
  if (presenter) {
    const broll = snapDuration(4, plannedDurations(clip));
    return { voice: CLICK_TO_AD.maxSeconds - broll, broll };
  }
  const shots = engine === "open" ? adShots(clip) : [4, 4, 4];
  return { voice: Math.max(4, Math.min(CLICK_TO_AD.maxSeconds, shots.reduce((a, b) => a + b, 0)) - 0.6), broll: 0 };
}

/**
 * A product-only ad's shots on the open engine: about 9 s, in at least two shots so two of the kit's angles show (a model
 * whose shortest planned clip is 5 s, MiniMax H3, makes two 5 s shots rather than one 10 s clip).
 */
function adShots(clip: ModelDef): number[] {
  const ds = plannedDurations(clip);
  const plan = shotPlan(9, ds);
  if (plan.length > 1 || !ds?.length) return plan;
  const shortest = Math.min(...ds);
  return 2 * shortest <= CLICK_TO_AD.maxSeconds ? [shortest, shortest] : plan;
}

/** A raster logo overlay-image can place (an SVG can't be read there), else undefined. */
const rasterLogo = (brand?: BrandKit | null) => (brand?.logo && !isSvg(brand.logo) ? brand.logo : undefined);

/**
 * Who encoded a step's clip: video-append-endcard copies the ad's packets, so it only takes a clip ComfyUI made
 * (every open Click to Ad final today); anything else gets still-to-clip + the sound-keeping join.
 */
export function adEncoder(step: Pick<Step, "request"> | undefined): "comfyui" | "other" {
  const m = step && getModel(step.request.modelId);
  const op = step?.request.op;
  return m && op && routesFor(m, op).length && routesFor(m, op).every((r) => r.provider === "comfyui") ? "comfyui" : "other";
}

/**
 * The ad, then its logo end card: the ad's last step becomes a helper and the card's join is the result
 * (endCardSteps: cloud ken-burns + a silent track + merge-videos, open video-append-endcard).
 */
function withEndCard(plan: RunPlan, input: ClickToAdInput, ctx: { brand?: BrandKit | null; background?: string; silence?: string }): RunPlan {
  if (!input.endCard) return plan;
  const ad = plan.finals[0];
  const card = endCardSteps({
    engine: plan.engine,
    ad,
    adEncodedBy: plan.engine === "open" ? adEncoder(plan.steps.find((s) => s.key === ad)) : undefined,
    card: input.endCard.image,
    clip: input.endCard.clip,
    background: ctx.background,
    logo: rasterLogo(ctx.brand),
    silence: ctx.silence,
    seconds: input.endCard.seconds,
    feature: plan.feature,
    title: plan.title,
    aspectRatio: CLICK_TO_AD.aspect,
    resolution: input.quality ?? "480p",
  });
  const steps = plan.steps.map((s) => {
    if (s.key !== ad) return s;
    const request = { ...s.request, feature: `${plan.feature}-step` };
    delete request.title;
    return { ...s, request };
  });
  const seconds = Math.max(END_CARD.minSeconds, Math.min(END_CARD.maxSeconds, input.endCard.seconds ?? END_CARD.seconds));
  const animated = !!input.endCard.clip;
  const notes = [...plan.notes, `Ends on your ${animated ? "animated " : ""}logo card for ${seconds} s${input.endCard.image || animated ? "" : " (the kit's logo on its main colour)"}`];
  const meta = { ...plan.meta, endCard: input.endCard.image ?? null, ...(animated && { endCardClip: input.endCard.clip, endCardVariant: input.endCard.variant ?? null }) };
  return { ...plan, steps: [...steps, ...card.steps], finals: [card.final], meta, notes };
}

export function planClickToAd(input: ClickToAdInput, ctx: { product: Product; brand?: BrandKit | null; script: string; background?: string; silence?: string }): RunPlan {
  try {
    return withEndCard(planAd(input, ctx), input, ctx);
  } catch (e) {
    throw e instanceof PlanError ? e : new PlanError((e as Error).message);
  }
}

function planAd(input: ClickToAdInput, ctx: { product: Product; brand?: BrandKit | null; script: string }): RunPlan {
  const style = styleById(input.styleId);
  if (!style) throw new PlanError("Pick a style");
  const images = input.images?.length ? input.images : ctx.product.images;
  if (!images.length) throw new PlanError(`${ctx.product.name} has no images`);
  const presenter = input.presenter ?? style.presenter;
  const open = input.engine === "open";
  const title = `${style.name} · ${ctx.product.name}`;
  const meta: MarketingRunMeta = { productId: ctx.product.id, brandId: ctx.brand?.id ?? null, styleId: style.id, script: ctx.script };
  const notes: string[] = [];
  const quality = input.quality ?? "480p";
  if (presenter) {
    return planPresenter({
      feature: "click-to-ad",
      engine: input.engine,
      title,
      meta,
      script: ctx.script,
      product: ctx.product,
      productImages: images,
      brand: ctx.brand ?? null,
      avatar: input.avatar,
      aspect: CLICK_TO_AD.aspect,
      look: style.visual,
      voice: input.voice,
      voiceSample: input.voiceSample,
      broll: true,
      brollSeconds: clickToAdSeconds(input.engine, true).broll,
      quality,
      notes,
    });
  }
  // Product only: three shots from the kit's pictures, joined, the voiceover laid under, then captions.
  if (!ctx.script.trim()) throw new PlanError("Write the script first");
  if (open && !input.voiceSample) throw new PlanError("Add a voice sample — open-source voices are cloned from a short recording");
  const M = UGC_MODELS[input.engine];
  const clip = need(M.clip);
  const lens = open ? adShots(clip) : [4, 4, 4];
  const angles = ["Hero shot, the camera glides in", "Close-up on the details as light sweeps across", "The product in use, ending on a clean final frame"];
  const step = "click-to-ad-step";
  const shotAspect = nearestAspect(CLICK_TO_AD.aspect, clip.options.aspectRatios);
  // MiniMax H3 on your GPU keeps each photo's shape: a photo of another shape is grown to 9:16 first.
  const fits: Step[] = [];
  const frames = lens.map((_, i) => startFrame(fits, images[i % images.length], shotAspect === "auto" ? CLICK_TO_AD.aspect : shotAspect, clip, step));
  const steps: Step[] = [
    { key: "voice", label: "Voiceover", request: { feature: step, modelId: M.voice, op: "tts", prompt: ctx.script, inputs: open ? { voiceAudio: input.voiceSample } : undefined, params: !open && input.voice ? { voice: input.voice } : undefined } },
    ...fits,
    ...lens.map((d, i): Step => {
      const { after, ...frame } = frames[i];
      return {
        key: `shot${i + 1}`,
        label: `Shot ${i + 1} of ${lens.length}`,
        request: {
          feature: step,
          modelId: M.clip,
          op: "i2v",
          prompt: join(angles[i % angles.length], style.visual, `Vertical 9:16 ad for ${ctx.product.name}`, KEEP_PRODUCT, ctx.brand && brandLine(ctx.brand)),
          ...frame,
          params: { aspectRatio: shotAspect, duration: d, resolution: quality, ...(clip.options.audio && { generateAudio: false }) },
        },
        ...(after && { after }),
      };
    }),
    {
      key: "film",
      label: "Joining the shots",
      request: { feature: step, modelId: M.join, op: "concat", prompt: title, params: { aspectRatio: nearestAspect(CLICK_TO_AD.aspect, need(M.join).options.aspectRatios) }, chain: lens.map(() => ({ slot: "videos" as const })) },
      after: lens.map((_, i) => `shot${i + 1}`),
    },
    { key: "mux", label: "Adding the voiceover", request: { feature: step, modelId: M.mux, op: "mux" }, after: ["film", "voice"], chain: [{ slot: "video" }, { slot: "audio" }] },
    {
      key: "captions",
      label: "Captions",
      request: open
        ? { feature: "click-to-ad", modelId: M.captions, op: "captions", prompt: cueLines(estimateCues(ctx.script)), title, batchTitle: title }
        : { feature: "click-to-ad", modelId: M.captions, op: "captions", title, batchTitle: title },
      after: ["mux"],
      chain: [{ slot: "video" }],
    },
  ];
  if (open) notes.push("Open captions are timed from the script at a natural speaking pace");
  return { feature: "click-to-ad", engine: input.engine, title, steps, finals: ["captions"], meta, notes };
}

// ---------------------------------------------------------------------------
// Ad Multiplier: a reference ad (4–30 s) → new versions (whole ad, or a new hook / CTA around it)

/** How each cloud edit model is asked to keep the reference's own soundtrack. */
const KEEP_SOUND: Record<string, Record<string, unknown>> = { "kling-o3": { keep_audio: true }, "happy-horse-video-edit": { audio_setting: "origin" } };

export function multiplierModel(input: Pick<MultiplierInput, "engine" | "modelId">): ModelDef {
  const choices = keepOffered(MULTIPLIER_MODELS[input.engine], (c) => isOffered(c.id, input.engine));
  const id = input.modelId && choices.some((c) => c.id === input.modelId) ? input.modelId : choices[0].id;
  return need(id);
}

export interface MultiplierContext {
  extractFrame?: boolean;
  /** The reference has a soundtrack (null or missing: its header couldn't be read). */
  referenceSound?: boolean | null;
  /** The reference's shape ("9:16"), from its header. */
  referenceAspect?: string;
}

export function planMultiplier(input: MultiplierInput, ctx: MultiplierContext): RunPlan {
  const open = input.engine === "open";
  const start = Math.max(0, input.start ?? 0);
  const asked = Math.min(input.duration, input.end ?? input.duration);
  const length = asked - start;
  if (length < MULTIPLIER.minSeconds - 0.05 || length > MULTIPLIER.maxSeconds + 0.05) throw new PlanError("Video duration: 4-30 seconds");
  const images = input.images ?? [];
  const text = multiplierText({ mode: input.mode, prompt: input.prompt, hook: input.hook, cta: input.cta });
  if (input.mode === "sections" && input.hook == null && input.cta == null) throw new PlanError("Turn on Change hook or Change CTA");
  const M = UGC_MODELS[input.engine];
  const step = "ad-multiplier-step";
  const meta: MarketingRunMeta = { mode: input.mode };
  const notes: string[] = [];
  const steps: Step[] = [];
  const resolution = multiplierResolution(input.quality, input.engine);
  // A cloud edit model that recreates a shorter part than the one selected gets its first seconds (MULTIPLIER_WINDOW).
  const editModel = input.mode === "prompt" ? multiplierModel(input) : undefined;
  const window = !open && editModel ? MULTIPLIER_WINDOW[editModel.id] : undefined;
  const end = window && length > window + 0.05 ? start + window : asked;
  if (end < asked) notes.push(`${editModel!.name} recreates up to ${window} s: the first ${window} s of your selection are used (move the selection for another part)`);
  const trimmed = start > 0.05 || end < input.duration - 0.05;
  if (trimmed) {
    steps.push({ key: "clip", label: "Trimming the reference", request: { feature: step, modelId: M.trim, op: "trim", inputs: { video: input.video }, params: { startTime: round(start), endTime: round(end) } } });
  }
  const source = (slot: "video"): { inputs?: GenerationRequest["inputs"]; after?: string[]; chain?: ChainSlot[] } =>
    trimmed ? { after: ["clip"], chain: [{ slot }] } : { inputs: { video: input.video } };

  if (editModel) {
    const model = editModel;
    const title = `Recreated ad · ${model.name}`;
    if (open) {
      // Wan Animate: the first image takes over the reference's performance; the original sound is laid back on.
      const lead = mentionsFor(text, images, model.id, 1);
      if (!lead.images.length) throw new PlanError("Add an image of who (or what) should star in the new version");
      const src = source("video");
      steps.push({
        key: "edit",
        label: "Recreating",
        request: {
          feature: trimmed ? "ad-multiplier" : step,
          // Fuobe Genjutsu's Original runs on both engines: this is its open half.
          engine: "open",
          modelId: model.id,
          op: "motion-transfer",
          prompt: lead.prompt,
          inputs: { ...src.inputs, images: lead.images },
          chain: src.chain,
          ...(trimmed && { title, batchTitle: title }),
        },
        after: src.after,
      });
      if (ctx.referenceSound === false) {
        // A silent reference: nothing to lay back on.
        const edit = steps[steps.length - 1];
        edit.request = { ...edit.request, feature: "ad-multiplier", title, batchTitle: title };
      } else if (!trimmed) {
        steps.push({ key: "sound", label: "Original sound", request: { feature: "ad-multiplier", modelId: M.mux, op: "mux", inputs: { audio: input.video }, title, batchTitle: title }, after: ["edit"], chain: [{ slot: "video" }] });
      } else {
        notes.push("Wan Animate makes the picture only; use the whole clip to keep its original sound");
      }
      if (images.length > 1) notes.push("Wan Animate uses one image (the first you mention)");
    } else {
      // A model whose edit route takes no images (Gemini Omni Flash) edits from the prompt alone.
      const max = model.routes.some((r) => r.op === "v2v" && r.map?.images) ? (model.options.maxImages ?? 0) : 0;
      const m = mentionsFor(text, images, model.id, max);
      if (m.dropped && images.length) notes.push(max ? `${model.name} takes ${max} images — the first ${max} you mention are used` : `${model.name} edits from the prompt alone; pick Kling O3 to use your images`);
      const src = source("video");
      steps.push({
        key: "edit",
        label: "Recreating",
        request: {
          feature: "ad-multiplier",
          modelId: model.id,
          op: "v2v",
          prompt: m.prompt,
          inputs: { ...src.inputs, ...(m.images.length && { images: m.images }) },
          // The clip's length prices the edit (a v2v route sends none); the reference's own sound is kept (Kling's
          // keep_audio, Happy Horse's audio_setting "origin").
          params: { resolution, duration: round(end - start), ...(KEEP_SOUND[model.id] && { extra: KEEP_SOUND[model.id] }) },
          chain: src.chain,
          title,
          batchTitle: title,
        },
        after: src.after,
      });
    }
    return { feature: "ad-multiplier", engine: input.engine, title, steps, finals: [steps[steps.length - 1].key], meta, notes };
  }

  // Hook / CTA: a new clip from the first (or last) frame, joined around the original.
  const clipModel = need(M.clip);
  const title = [input.hook != null && "New hook", input.cta != null && "New CTA"].filter(Boolean).join(" + ");
  const frameModel = getModel(M.frame);
  const canExtract = !!frameModel && (ctx.extractFrame ?? true);
  const clipAspect = nearestAspect(ctx.referenceAspect, clipModel.options.aspectRatios);
  const clipParams = { duration: snapDuration(4, plannedDurations(clipModel)), ...(clipModel.options.audio && { generateAudio: true }), resolution: nearestRes(resolution, clipModel), ...(clipAspect && { aspectRatio: clipAspect }) };
  const order: string[] = [];
  if (input.hook != null) {
    const start = input.firstFrame ?? images[0];
    if (!start) throw new PlanError("Couldn't read the clip's first frame here — add an image to start the hook from");
    if (!input.firstFrame) notes.push("The hook starts from your first image (the clip's first frame couldn't be read in this browser)");
    steps.push({
      key: "hook",
      label: "New hook",
      request: { feature: step, modelId: M.clip, op: "i2v", prompt: join(`Opening hook of the ad: the person on screen says “${(input.hook ?? "").trim() || "Wait — you need to see this"}”`, "Same people, place, light and style as this frame", "Punchy, scroll-stopping first seconds"), inputs: { images: [start] }, params: clipParams },
    });
    order.push("hook");
  }
  order.push(trimmed ? "clip" : "original");
  if (input.cta != null) {
    const ctaPrompt = join(`Closing call to action: the person on screen says “${(input.cta ?? "").trim() || "Try it today"}”`, "Same people, place, light and style as this frame", "End on a confident, clean final frame");
    if (input.lastFrame) {
      steps.push({ key: "cta", label: "New CTA", request: { feature: step, modelId: M.clip, op: "i2v", prompt: ctaPrompt, inputs: { images: [input.lastFrame] }, params: clipParams } });
    } else if (canExtract) {
      const src = source("video");
      steps.push({ key: "last", label: "Last frame", request: { feature: step, modelId: M.frame, op: "frame", inputs: src.inputs, chain: src.chain }, after: src.after });
      steps.push({ key: "cta", label: "New CTA", request: { feature: step, modelId: M.clip, op: "i2v", prompt: ctaPrompt, params: clipParams, chain: [{ slot: "images", position: "first" }] }, after: ["last"] });
    } else {
      const fallbackImg = images[0];
      if (!fallbackImg) throw new PlanError("Couldn't read the clip's last frame here — add an image to end on");
      steps.push({ key: "cta", label: "New CTA", request: { feature: step, modelId: M.clip, op: "i2v", prompt: ctaPrompt, inputs: { images: [fallbackImg] }, params: clipParams } });
      notes.push("The CTA starts from your first image (the clip's last frame couldn't be read in this browser)");
    }
    order.push("cta");
  }
  // The open join keeps the reference's own sound (after the new hook when there is one); a reference whose
  // header couldn't be read goes through the plain join, which keeps the picture only.
  const keepSound = open && !!ctx.referenceSound;
  const joiner = need(keepSound ? (input.hook != null ? OPEN_SOUND_JOIN.second : OPEN_SOUND_JOIN.first) : M.join);
  const stepKeys = order.filter((k) => k !== "original");
  // The original goes in as an input; its place among the chained clips follows from position first/last.
  const chain: ChainSlot[] = stepKeys.map((k) => ({ slot: "videos" as const, position: order.indexOf(k) < order.indexOf("original") ? ("first" as const) : ("last" as const) }));
  steps.push({
    key: "film",
    label: "Final video",
    request: {
      feature: "ad-multiplier",
      modelId: joiner.id,
      op: "concat",
      prompt: title,
      inputs: trimmed ? undefined : { videos: [input.video] },
      ...(keepSound && { params: { aspectRatio: nearestAspect(ctx.referenceAspect, joiner.options.aspectRatios) ?? "auto", resolution: nearestRes(resolution, joiner) } }),
      chain,
      title,
      batchTitle: title,
    },
    after: stepKeys,
  });
  if (open && ctx.referenceSound == null) notes.push("This clip's soundtrack couldn't be read here, so the joined ad keeps the picture only");
  return { feature: "ad-multiplier", engine: input.engine, title, steps, finals: ["film"], meta, notes };
}

const round = (n: number) => Math.round(n * 100) / 100;

const ISO: Record<string, string> = {
  English: "en", Spanish: "es", French: "fr", German: "de", Italian: "it", Portuguese: "pt", Dutch: "nl", Polish: "pl", Russian: "ru", Turkish: "tr", Japanese: "ja",
  Korean: "ko", Chinese: "zh", Arabic: "ar", Hindi: "hi", Swedish: "sv", Danish: "da", Norwegian: "no", Finnish: "fi", Greek: "el", Czech: "cs", Hungarian: "hu",
  Romanian: "ro", Ukrainian: "uk", Vietnamese: "vi", Thai: "th", Indonesian: "id", Hebrew: "he", Kazakh: "kk",
};
/** The spoken language for the cloud captioner (ISO code); English needs none. */
const languageCode = (name?: string) => (name && name !== "English" ? ISO[name] : undefined);
/**
 * The model's tier for the one asked: the same, else the tallest at or below it, else its first. Ranked by the height a
 * tier names (targetShortEdge: "2K" is 1440, never 2), so a finishing tier can't pass for the smallest.
 */
function nearestRes(want: string, m: ModelDef): string {
  const offered = m.options.resolutions ?? [];
  if (offered.includes(want)) return want;
  const h = targetShortEdge(want);
  const below = h === undefined ? [] : offered.filter((r) => (targetShortEdge(r) ?? Infinity) <= h).sort((a, b) => targetShortEdge(a)! - targetShortEdge(b)!);
  return below.pop() ?? offered[0] ?? want;
}

// ---------------------------------------------------------------------------
// Estimates and launching

/**
 * The plan with every step on the run's engine: a Fuobe Original runs on both, and a step that doesn't name one would
 * run on the first engine connected (your GPU before the cloud) instead of the one picked in the studio.
 */
export function onPlanEngine(plan: RunPlan): RunPlan {
  const pin = (s: Step): Step => (s.request.engine || !dualEngine(getModel(s.request.modelId)) ? s : { ...s, request: { ...s.request, engine: plan.engine } });
  return plan.steps.some((s) => pin(s) !== s) ? { ...plan, steps: plan.steps.map(pin) } : plan;
}

/** Price and validate every step with placeholders for what earlier steps make (nothing is created). */
export function estimatePlan(input: RunPlan, runs = 1): RunEstimate {
  const plan = onPlanEngine(input);
  let total: number | null = 0;
  let demo = false;
  const steps: PlannedStep[] = [];
  for (const s of plan.steps) {
    const p = previewChained({ ...s.request, ...(s.chain && { chain: s.chain }) }, s.after?.length ?? 0);
    demo ||= p.demo;
    steps.push({ key: s.key, label: s.label, modelId: p.model.id, modelName: p.model.name, costUsd: p.costUsd });
    total = total === null || p.costUsd === null ? null : total + p.costUsd;
  }
  return { costUsd: total === null ? null : Math.round(total * runs * 1000) / 1000, demo, steps, notes: plan.notes, runs };
}

interface RunRow {
  id: string;
  feature: RunFeature;
  batch_id: string;
  final_ids_json: string;
  engine: Engine;
  title: string;
  meta_json: string;
  created_at: number;
}

/** Create the run's generations (one request, or a pipeline) and record the run. */
export function launch(planned: RunPlan, input?: object): MarketingRun {
  const plan = onPlanEngine(planned);
  const engine = engineMode();
  if (engine !== "both" && engine !== plan.engine) throw new PlanError(engine === "open" ? "This install is set to open source only (Settings → Engine mode)" : "This install is set to paid cloud APIs only (Settings → Engine mode)");
  const batchId = nanoid(10);
  let byKey: Record<string, { id: string }[]>;
  if (plan.steps.length === 1 && !plan.steps[0].after?.length) {
    const s = plan.steps[0];
    byKey = { [s.key]: createGenerations(s.request, { batchId }) };
  } else {
    const n = plan.steps.length;
    const steps: PipelineStep[] = plan.steps.map((s, i) => ({ key: s.key, request: { ...s.request, step: { label: s.label, index: i, of: n } }, after: s.after, chain: s.chain }));
    const made = createPipeline(steps, { batchId });
    byKey = Object.fromEntries(Object.entries(made.byKey).map(([k, g]) => [k, [g]]));
  }
  const finalIds = plan.finals.flatMap((k) => byKey[k]?.map((g) => g.id) ?? []);
  const row: RunRow = { id: nanoid(10), feature: plan.feature, batch_id: batchId, final_ids_json: JSON.stringify(finalIds), engine: plan.engine, title: plan.title, meta_json: JSON.stringify({ ...plan.meta, notes: plan.notes, ...(input && { input }) }), created_at: Date.now() };
  db().prepare("INSERT INTO marketing_runs (id, feature, batch_id, final_ids_json, engine, title, meta_json, created_at) VALUES (@id, @feature, @batch_id, @final_ids_json, @engine, @title, @meta_json, @created_at)").run(row);
  return toRun(row);
}

function toRun(r: RunRow): MarketingRun {
  const generations = listGenerations({ batchId: r.batch_id, limit: 200 }).sort((a, b) => a.createdAt - b.createdAt || (a.request.step?.index ?? 0) - (b.request.step?.index ?? 0));
  return { id: r.id, feature: r.feature, batchId: r.batch_id, engine: r.engine, title: r.title, finalIds: JSON.parse(r.final_ids_json) as string[], meta: JSON.parse(r.meta_json) as MarketingRunMeta, createdAt: r.created_at, generations };
}

/** Runs of one flow, newest first; a run whose generations were all trashed or deleted drops out. */
export function listRuns(feature: RunFeature, limit = 30): MarketingRun[] {
  const rows = db().prepare("SELECT * FROM marketing_runs WHERE feature = ? ORDER BY created_at DESC LIMIT ?").all(feature, Math.min(100, Math.max(1, limit))) as RunRow[];
  return rows.map(toRun).filter((r) => r.generations.length > 0);
}

export function getRun(id: string): MarketingRun | null {
  const r = db().prepare("SELECT * FROM marketing_runs WHERE id = ?").get(id) as RunRow | undefined;
  return r ? toRun(r) : null;
}

/** Forget a run (its generations stay in the Library). */
export function deleteRun(id: string): boolean {
  return db().prepare("DELETE FROM marketing_runs WHERE id = ?").run(id).changes > 0;
}

function context(input: { productId?: string; brandId?: string }) {
  const product = input.productId ? getProduct(input.productId) : null;
  if (input.productId && !product) throw new PlanError("This product is no longer available. Choose another one.");
  const brand = input.brandId ? getBrand(input.brandId) : product?.brandId ? getBrand(product.brandId) : null;
  return { product, brand };
}

/** The shortest talking part a UGC film gets, however short the length asked for. */
const MIN_TALK_SECONDS = 5;

/**
 * Seconds the presenter talks in a UGC film: the length asked for minus the hook clip before it and
 * the product close-up after it, so the whole film comes out about as long as the Length setting.
 */
export function presenterSeconds(input: MarketingInput, ctx: { product?: Product | null }): number {
  const f = FORMATS[input.format];
  const want = input.duration ?? f.durations?.default ?? 15;
  const tpl = input.templateId ? TEMPLATE_INDEX.get(input.templateId) : undefined;
  const shot = snapDuration(4, plannedDurations(need(UGC_MODELS[input.engine].clip)));
  const hook = f.hookAndSetting && hookById(input.hookId === undefined ? tpl?.hook : input.hookId);
  const broll = !!(input.productImages?.length || ctx.product?.images.length);
  return Math.max(MIN_TALK_SECONDS, want - (hook ? shot : 0) - (broll ? shot : 0));
}

/**
 * How many runs a Marketing Studio batch is: one run of every picture for an image format, unless its words are set
 * in the browser (Fuobe Marketing Image, open models), which composes one picture per run; one run per video.
 */
function runsFor(input: MarketingInput, plan: RunPlan): number {
  const f = FORMATS[input.format];
  const batch = Math.min(input.batch ?? 1, f.batch);
  return f.pipeline === "image" && !plan.meta.overlay ? 1 : batch;
}

/** Marketing Studio: price a run (a stand-in script of the right length for UGC; no LLM call). */
export function estimateMarketing(input: MarketingInput): RunEstimate {
  const ctx = context(input);
  const f = FORMATS[input.format];
  const script = f.pipeline === "ugc" ? input.script?.trim() || Array(wordBudget(presenterSeconds(input, ctx))).fill("word").join(" ") : undefined;
  const plan = planMarketing(input, { ...ctx, script });
  return estimatePlan(plan, runsFor(input, plan));
}

export async function runMarketing(input: MarketingInput): Promise<{ runs: MarketingRun[]; script?: string }> {
  const ctx = context(input);
  const f = FORMATS[input.format];
  const tpl = input.templateId ? TEMPLATE_INDEX.get(input.templateId) : undefined;
  if (tpl && isCodeTemplate(tpl)) throw new PlanError(CODE_TEMPLATE_REFUSAL);
  let script: string | undefined;
  if (f.pipeline === "ugc") {
    const hook = hookById(input.hookId === undefined ? tpl?.hook : input.hookId);
    const seconds = presenterSeconds(input, ctx);
    script = input.script?.trim()
      ? fitScript(input.script, seconds)
      : (await writeScript({ product: ctx.product, brand: ctx.brand, seconds, hook: hook?.prompt, angle: tpl?.prompt, instructions: input.prompt })).script;
  }
  const plan = planMarketing(input, { ...ctx, script });
  const runs = runsFor(input, plan);
  // Check the whole plan (prices, models, engine mode, demo/real) before creating anything.
  estimatePlan(plan);
  return { runs: Array.from({ length: runs }, () => launch(plan, { ...input, batch: 1 })), script };
}

export function estimateClickToAd(input: ClickToAdInput): RunEstimate {
  const ctx = context({ productId: input.productId });
  const presenter = input.presenter ?? styleById(input.styleId)?.presenter ?? false;
  const script = input.script?.trim() || Array(wordBudget(clickToAdSeconds(input.engine, presenter).voice)).fill("word").join(" ");
  return estimatePlan(planClickToAd(input, { product: ctx.product!, brand: ctx.brand, script, background: "/api/files/placeholder.png", silence: "/api/files/placeholder.wav" }));
}

/**
 * The end card's background when the page drew none: the kit's accent at the card's size (cloud: the logo goes on
 * it), the colour the page's card uses (themeFrom), so a white logo isn't put on a white first colour.
 */
export function cardBackground(brand?: BrandKit | null): string {
  const hex = themeFrom(brand).accent;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const { w, h } = END_CARD.size;
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set([r, g, b, 255], i);
  return saveFile({ data: encodePng({ width: w, height: h, data }), contentType: "image/png", source: "generation", name: "end-card-background.png" }).url;
}

/** A silent 16-bit stereo WAV `seconds` long (44.1 kHz). */
export function silentWav(seconds: number, rate = 44100): Buffer {
  const frames = Math.round(seconds * rate);
  const bytes = frames * 4;
  const buf = Buffer.alloc(44 + bytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(bytes, 40);
  return buf;
}

/** The cloud end card's sound track: silence as long as the card. */
function cardSilence(seconds?: number): string {
  const s = Math.max(END_CARD.minSeconds, Math.min(END_CARD.maxSeconds, seconds ?? END_CARD.seconds));
  return saveFile({ data: silentWav(s), contentType: "audio/wav", source: "generation", name: "end-card-silence.wav" }).url;
}

export async function clickToAdScript(input: Pick<ClickToAdInput, "engine" | "productId" | "styleId" | "presenter" | "instructions">): Promise<{ script: string; by: "llm" | "rules"; seconds: number }> {
  const ctx = context({ productId: input.productId });
  const style = styleById(input.styleId) ?? AD_STYLES[0];
  const seconds = clickToAdSeconds(input.engine, input.presenter ?? style.presenter).voice;
  const r = await writeScript({ product: ctx.product, brand: ctx.brand, seconds, style: `${style.name}: ${style.voice}`, instructions: input.instructions });
  return { ...r, seconds };
}

export async function runClickToAd(input: ClickToAdInput): Promise<{ run: MarketingRun; script: string }> {
  const ctx = context({ productId: input.productId });
  if (!ctx.product) throw new PlanError("Select a product or enter a product URL");
  const presenter = input.presenter ?? styleById(input.styleId)?.presenter ?? false;
  const seconds = clickToAdSeconds(input.engine, presenter).voice;
  const script = input.script?.trim() ? fitScript(input.script, seconds) : (await clickToAdScript(input)).script;
  // Checked first with stand-ins, so a plan that can't run writes no file.
  const cloudCard = !!input.endCard && input.engine === "cloud";
  const fallback = cloudCard && !input.endCard?.image && !input.endCard?.clip;
  if (cloudCard) planClickToAd(input, { product: ctx.product, brand: ctx.brand, script, background: "/api/files/placeholder.png", silence: "/api/files/placeholder.wav" });
  const plan = planClickToAd(input, {
    product: ctx.product,
    brand: ctx.brand,
    script,
    background: fallback ? cardBackground(ctx.brand) : undefined,
    silence: cloudCard ? cardSilence(input.endCard?.seconds) : undefined,
  });
  estimatePlan(plan);
  return { run: launch(plan, { ...input, script }), script };
}

/**
 * Whether a stored clip has a soundtrack, and its shape, from the file's own header: only the header is read, cached by
 * the file itself (not by the text of the request), and a visitor's price check reads only its own clip (storedMedia).
 * Not readable here: unknown, and the plan falls back to what works without knowing.
 */
export async function referenceFacts(ref: string): Promise<{ sound: boolean | null; aspect?: string }> {
  const info = storedMedia(ref)?.info;
  if (!info?.hasVideo) return { sound: null };
  return { sound: info.hasAudio, aspect: info.width && info.height ? nearestAspect(`${info.width}:${info.height}`, ["9:16", "4:5", "3:4", "1:1", "4:3", "16:9", "21:9"]) : undefined };
}

async function multiplierContext(input: MultiplierInput): Promise<MultiplierContext> {
  const facts = await referenceFacts(input.video);
  return { referenceSound: facts.sound, referenceAspect: facts.aspect };
}

export async function estimateMultiplier(input: MultiplierInput): Promise<RunEstimate> {
  const plan = planMultiplier(input, await multiplierContext(input));
  return estimatePlan(plan, input.versions ?? 1);
}

export async function runMultiplier(input: MultiplierInput): Promise<MarketingRun[]> {
  const plan = planMultiplier(input, await multiplierContext(input));
  estimatePlan(plan);
  return Array.from({ length: input.versions ?? 1 }, () => launch(plan, { ...input, versions: 1 }));
}

/** "Run again": the same input as a new run (a UGC script is written afresh unless it was given). */
export async function rerun(id: string): Promise<MarketingRun[]> {
  const r = getRun(id);
  if (!r) throw new PlanError("Not found");
  const input = r.meta.input;
  if (!input) throw new PlanError("This run can't be repeated — start it again from the form");
  if (r.feature === "click-to-ad") return [(await runClickToAd(ClickToAdBody.parse(input))).run];
  if (r.feature === "ad-multiplier") return await runMultiplier(MultiplierBody.parse(input));
  return (await runMarketing(MarketingBody.parse(input))).runs;
}

/**
 * A poster/ad with its words set in the browser (an uploaded PNG: open models, Fuobe Marketing Image), recorded in the Library
 * and on the run (the card shows it). `auto`: the first composite the browser makes on its own once the
 * picture is ready; a run that has one already keeps it (no duplicate from a second tab).
 */
export function saveRunComposite(id: string, input: { url: string; ratio: string; text: string; overlay?: RunOverlay; auto?: boolean }) {
  const r = getRun(id);
  if (!r) throw new PlanError("Not found");
  if (input.auto && r.meta.composed) {
    const existing = getGeneration(r.meta.composed.id);
    if (existing) return existing;
  }
  const source = r.generations.find((g) => r.finalIds.includes(g.id))?.outputs.find((o) => o.kind === "image")?.url;
  const g = recordLocalGeneration({
    feature: r.feature,
    modelId: "local-ad-compose",
    op: "edit",
    prompt: input.text.slice(0, 500) || r.title,
    inputs: source ? { images: [source] } : {},
    params: { aspectRatio: input.ratio },
    output: { url: input.url, kind: "image", contentType: "image/png" },
  });
  const meta: MarketingRunMeta = { ...r.meta, composed: { id: g.id, url: input.url }, ...(input.overlay && { overlay: input.overlay }) };
  db().prepare("UPDATE marketing_runs SET meta_json = ? WHERE id = ?").run(JSON.stringify(meta), id);
  return g;
}

// ---------------------------------------------------------------------------
// Route helpers (src/app/api/{brands,products,ads,marketing}/**)

/** Parse a JSON body; a 400 Response with a readable message when it doesn't fit. */
export async function readBody<S extends z.ZodType>(request: Request, schema: S, message = "Check the form and try again"): Promise<z.infer<S> | Response> {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  return Response.json({ error: first ? `${message} (${first.path.join(".") || "body"}: ${first.message})` : message }, { status: 400 });
}

/** A thrown error as a JSON response: 409 for duplicates, 422 for everything the user can fix. */
export function failure(e: unknown): Response {
  const err = e as Error;
  const status = err?.name === "DuplicateProductError" || err?.constructor?.name === "DuplicateProductError" ? 409 : 422;
  return Response.json({ error: err?.message || "Something went wrong" }, { status });
}
