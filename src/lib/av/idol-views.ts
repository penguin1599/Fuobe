import type { GenerationRequest, OutputFile } from "@/lib/catalog/types";
import { IDOL_MODELS, IDOL_WORKFLOWS, VIEW_SIDES, idolExtra, type ViewSide } from "@/lib/av/model3d";

/**
 * "Make the other sides from the front" (idol-8, docs/research/idol-9.md §8): Idol 3D builds a splat of the object in one
 * picture on your GPU, and the image-to-views-idol graph renders it from the camera Idol predicted for that picture, then
 * three more times a quarter turn apart. The four pictures fill From several images' sides (TRELLIS.2 multi-view) and an
 * element's references. They are renders of a 3D guess, so they can be soft; faces and people are the risky case (eval first).
 * Open engine only: Idol's fal endpoint returns a splat, not views, and nothing else stands in for it.
 */
export const IDOL_VIEWS_WORKFLOW = "image-to-views-idol";
/** params.extra key that asks Idol 3D's open route for the four views (src/lib/comfy-variants.ts swaps the graph). */
export const IDOL_VIEWS_PARAM = "idolViews";
/** A helper job ("-step"): the views land in the slots or the element, not in the Library on their own. */
export const IDOL_VIEWS_FEATURE = "image-to-3d-views-step";
/** The graph's RenderSplat frames: four views, 90° apart. */
export const IDOL_VIEWS_FRAMES = 4;

/**
 * Which side each rendered view is (meta.index → side). RenderSplat with frames +4 turns the camera about world +Y
 * (three.js, Y up) toward the viewer's right, which is the object's own left (SIDES_HINT: "facing its front, walk round to
 * your right for its left side"); checked with an asymmetric splat through ComfyUI 0.41.0's RenderSplat. A negative frames
 * value would give the right side first.
 */
export const IDOL_VIEW_ORDER: readonly ViewSide[] = VIEW_SIDES;

/** The side a view at this index shows (undefined past the fourth). */
export function sideOfIndex(index: number): ViewSide | undefined {
  return Number.isInteger(index) && index >= 0 ? IDOL_VIEW_ORDER[index] : undefined;
}

/** The plain line beside every place that offers the views. */
export const IDOL_VIEWS_NOTE = "Rendered from a 3D guess of your photo, so they can look soft. Check each side before you use it.";

/** What the owner reads when their ComfyUI can't make the views (the run fails with it). */
export const IDOL_VIEWS_NEEDS_PACK = "Making the other sides needs the ComfyUI-Idol nodes on your ComfyUI";

/**
 * The run that makes the views: Idol 3D on the open engine with its Best settings, the picture's crop ("It's a photo": an
 * upload gets Idol's looser crop, a picture made here the tighter one) and the views asked for.
 */
export function idolViewsRequest(photo: string, o: { asPhoto?: boolean } = {}): GenerationRequest {
  return {
    feature: IDOL_VIEWS_FEATURE,
    modelId: IDOL_MODELS.open,
    op: "splat",
    inputs: { images: [photo] },
    params: { extra: { ...idolExtra("open", "best", o.asPhoto ?? true), [IDOL_VIEWS_PARAM]: true } },
  };
}

/** Whether a request asks for Idol's views (the graph swap, the demo's four pictures). */
export function wantsIdolViews(extra: Record<string, unknown> | undefined): boolean {
  return extra?.[IDOL_VIEWS_PARAM] === true;
}

/** The view graph a route's Idol endpoint runs as, when the request asks for views and the library has it. */
export function idolViewsGraph(endpoint: string, extra: Record<string, unknown>, has: (id: string) => boolean): string {
  return (endpoint === IDOL_WORKFLOWS.core || endpoint === IDOL_WORKFLOWS.clean) && wantsIdolViews(extra) && has(IDOL_VIEWS_WORKFLOW) ? IDOL_VIEWS_WORKFLOW : endpoint;
}

/** A view's own meta: its index in the batch and the side it shows. */
export function idolViewMeta(index: number): { index: number; side?: ViewSide } {
  const side = sideOfIndex(index);
  return { index, ...(side && { side }) };
}

/**
 * The finished views by side. An output's meta.side wins, else its meta.index, else its place among the images (the batch
 * keeps its order).
 */
export function idolViewsOf(outputs: Pick<OutputFile, "url" | "kind" | "meta">[]): Partial<Record<ViewSide, string>> {
  const out: Partial<Record<ViewSide, string>> = {};
  outputs
    .filter((o) => o.kind === "image")
    .forEach((o, i) => {
      const named = typeof o.meta?.side === "string" && (VIEW_SIDES as readonly string[]).includes(o.meta.side) ? (o.meta.side as ViewSide) : undefined;
      const side = named ?? sideOfIndex(typeof o.meta?.index === "number" ? o.meta.index : i);
      if (side && !out[side]) out[side] = o.url;
    });
  return out;
}

/** The sides the button fills: every one but the front. */
export const OTHER_SIDES = IDOL_VIEW_ORDER.filter((s) => s !== "front");

/** From several images offers the button with only the front filled (the person's own photos of other sides win). */
export function canMakeOtherSides(views: Partial<Record<ViewSide, unknown>>): boolean {
  return !!views.front && OTHER_SIDES.every((s) => !views[s]);
}

/**
 * The slots after a run: each side still empty gets its view; the front, and any side the person filled meanwhile, stay
 * as they are.
 */
export function fillOtherSides<T>(current: Partial<Record<ViewSide, T | null>>, made: Partial<Record<ViewSide, string>>, slot: (url: string, side: ViewSide) => T): Partial<Record<ViewSide, T | null>> {
  const next = { ...current };
  for (const s of OTHER_SIDES) if (!next[s] && made[s]) next[s] = slot(made[s]!, s);
  return next;
}

/** An element's new references: the left, back and right views (the front is the photo it came from), not already there. */
export function elementViews(made: Partial<Record<ViewSide, string>>, have: string[] = []): string[] {
  return OTHER_SIDES.flatMap((s) => (made[s] && !have.includes(made[s]!) ? [made[s]!] : []));
}

/**
 * The view run started for each front picture, kept for the tab rather than in the button: the button goes away when the
 * person switches mode or closes the dialog, and coming back to the same picture picks the run up again instead of
 * starting (and paying for) a second one. A run belongs to its picture, so a new front never gets the old front's views.
 */
const viewRuns = new Map<string, string>();

/** The run making views of this picture, if one was started in this tab and not handed over yet. */
export function viewRunFor(photo: string): string | undefined {
  return viewRuns.get(photo);
}

/** Remembers the run making views of this picture. */
export function rememberViewRun(photo: string, runId: string): void {
  viewRuns.set(photo, runId);
}

/** Forgets the picture's run once its views were handed over (only if it's still that run). */
export function forgetViewRun(photo: string, runId: string): void {
  if (viewRuns.get(photo) === runId) viewRuns.delete(photo);
}
