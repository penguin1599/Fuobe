import fs from "node:fs";
import { z } from "zod";
import { imageSize } from "@/lib/image-size";
import { RECIPE_MAX_BYTES, RecipeSchema, type Recipe } from "@/lib/motion/recipe";
import { designSize, exportSize } from "@/lib/motion/sizes";
import { ACCOUNT_LIMITS, ACCOUNT_MESSAGES, diskHasRoom } from "@/server/account-files";
import { fileAccount } from "@/server/account-library";
import { accountInputProblem } from "@/server/account-inputs";
import { requestViewer } from "@/server/auth";
import { getGeneration, recordLocalGeneration } from "@/server/generations";
import { moderateRun } from "@/server/hosted-run";
import { holdForCheck } from "@/server/output-checks";
import { hit, unhit } from "@/server/rate";
import { db } from "@/server/db";
import { absolutePath, contentTypeFor, filesRel } from "@/server/storage";
import { runAsTenant } from "@/server/tenant";

/** Kinetic's picture results: a frame, a contact sheet, a version (PNG images; every other Kinetic result is a clip). */
const KINETIC_IMAGE_FEATURES: readonly string[] = ["kinetic-frame", "kinetic-sheet", "kinetic-version"];
const imageFeature = (f: string) => KINETIC_IMAGE_FEATURES.includes(f);

/**
 * The pixel size a Kinetic result of this recipe has: a clip, a frame and a contact sheet are the export size (even
 * sides), a version is the rest frame with 540 px on its long side (render.ts makes them the same way).
 */
function kineticOutputSize(recipe: Recipe, feature: string): { width: number; height: number } {
  if (feature === "kinetic-version") {
    const d = designSize(recipe.size);
    const k = 540 / Math.max(d.w, d.h);
    return { width: Math.max(2, Math.round(d.w * k)), height: Math.max(2, Math.round(d.h * k)) };
  }
  const { w, h } = exportSize(recipe.size);
  return { width: w - (w % 2), height: h - (h % 2) };
}

/** A stored picture's pixel size, from its first bytes (null when it can't be read). */
function storedImageSize(rel: string): { width: number; height: number } | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(absolutePath(rel), "r");
    const head = new Uint8Array(64);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    return imageSize(head.subarray(0, n));
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

const Body = z
  .object({
    feature: z.string().min(1).max(80),
    modelId: z.string().min(1),
    op: z.enum(["grade", "relight", "motion"]),
    prompt: z.string().max(2000),
    title: z.string().max(200).optional(),
    inputs: z.object({ images: z.array(z.string().max(500)).max(4).optional(), video: z.string().max(500).optional() }),
    params: z.object({ extra: z.record(z.string(), z.unknown()).optional() }).optional(),
    output: z.object({
      url: z.string().startsWith("/api/files/").max(500),
      kind: z.enum(["image", "video"]),
      contentType: z.string().optional(),
      /** A clip's poster (its last frame), shown on its tile. */
      meta: z.object({ poster: z.string().startsWith("/api/files/").max(500) }).strict().optional(),
    }),
  })
  .superRefine((b, ctx) => {
    // A grade or a Relight blend is made from one picture; a motion clip from its logo and product (up to 4).
    if (b.op !== "motion" && (b.inputs.images?.length ?? 0) > 1) ctx.addIssue({ code: "custom", path: ["inputs", "images"], message: "One picture" });
    if (b.op === "motion") {
      const recipe = b.params?.extra?.motion;
      if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) ctx.addIssue({ code: "custom", path: ["params", "extra", "motion"], message: "The recipe" });
      else if (JSON.stringify(recipe).length > RECIPE_MAX_BYTES) ctx.addIssue({ code: "custom", path: ["params", "extra", "motion"], message: "The recipe is too big" });
      else if (!RecipeSchema.safeParse(recipe).success) ctx.addIssue({ code: "custom", path: ["params", "extra", "motion"], message: "The recipe" });
      // A frame, a contact sheet or a version is a PNG picture; everything else is an MP4 or WebM clip.
      if (imageFeature(b.feature)) {
        if (b.output.kind !== "image" || b.output.contentType !== "image/png") ctx.addIssue({ code: "custom", path: ["output"], message: "A PNG picture" });
      } else if (b.output.kind !== "video" || !/^video\/(mp4|webm)$/.test(b.output.contentType ?? "")) ctx.addIssue({ code: "custom", path: ["output"], message: "An MP4 or WebM clip" });
      // A clip under the words is the recipe's own clip, named as its video input; nothing else is a video input.
      if (b.inputs.video) {
        const parsed = RecipeSchema.safeParse(recipe);
        if (!parsed.success || parsed.data.layers?.video?.src !== b.inputs.video) ctx.addIssue({ code: "custom", path: ["inputs", "video"], message: "The recipe's clip" });
      }
    }
  });

const NOT_FOUND = "We can't find that.";
const refuse = (status: number, error: string, extra: Record<string, unknown> = {}) => Response.json({ error, ...extra }, { status, headers: { "Cache-Control": "no-store" } });

/** The asset behind a stored file's address, for the output check. */
function assetIdOf(url: string): string | undefined {
  const rel = filesRel(url);
  if (!rel) return undefined;
  const native = rel.split("/").join(process.platform === "win32" ? "\\" : "/");
  return (db().prepare("SELECT id FROM assets WHERE rel_path IN (?, ?) LIMIT 1").get(rel, native) as { id: string } | undefined)?.id;
}

/** The stored file's own type differs from what the result says it is (a picture is never recorded as a clip). */
function typeProblem(rel: string, output: { kind: string; contentType?: string }, op: string): boolean {
  const stored = contentTypeFor(rel);
  if (!stored.startsWith(`${output.kind}/`)) return true;
  if (output.contentType && output.contentType.split(";")[0].trim().toLowerCase() !== stored) return true;
  return op === "motion" && !(output.kind === "image" ? stored === "image/png" : /^video\/(mp4|webm)$/.test(stored));
}

/** The files a motion recipe names: its logo when it is stored here, its product and its pictures. */
function recipeFiles(extra: Record<string, unknown> | undefined): Record<string, string | string[]> {
  const r = RecipeSchema.safeParse(extra?.motion);
  if (!r.success) return {};
  const out: Record<string, string | string[]> = {};
  // A stored logo is checked as a file; the kit's own link is only kept (the server never fetches it for an account).
  // (" /api/files/…" is no stored file's path: it is checked, and refused, as written.)
  const logo = r.data.brand.logo;
  if (logo?.includes("/api/files/")) out._logo = logo;
  // Fuobe's own sample pictures (/previews/…) are public: only stored files are checked.
  const stored = (u: string) => u.startsWith("/api/files/");
  if (r.data.media?.product && stored(r.data.media.product)) out._product = r.data.media.product;
  const media = (r.data.media?.images ?? []).filter(stored);
  if (media.length) out._media = media;
  // The clip under the words (Kinetic's video layer): always a stored file.
  if (r.data.layers?.video?.src) out._clip = r.data.layers.video.src;
  return out;
}

/** The words a motion clip shows (its typed fields and the brand's name) and its title: what the studio's checks read. */
function shownWords(extra: Record<string, unknown> | undefined, title: string | undefined): string {
  const r = RecipeSchema.safeParse(extra?.motion);
  const words = r.success ? [...Object.values(r.data.fields), r.data.brand.name] : [];
  return [...new Set([...words, title ?? ""].map((w) => w.trim()).filter(Boolean))].join(" · ").slice(0, 2000);
}

/** What an account's grade or Relight blend is stored as: the picture or clip the page renders. */
const BROWSER_TYPES = /^(image\/png|video\/(mp4|webm))$/;

/**
 * Record a result rendered in the browser (a colour grade, a Relight blend, a Kinetic Motion clip) so it shows up in the
 * library. The owner records their own files. An account (public sign-up) records them too, each from files it uploaded
 * itself: the result is its own run (its own list, never the owner's Library), counted with its runs, and through the
 * studio's checks when they are on.
 */
export async function POST(request: Request) {
  const viewer = requestViewer(request);
  if (viewer.kind === "guest") return refuse(401, "Create a free account to run this.");
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return refuse(400, "Invalid result");
  const body = parsed.data;
  const rel = filesRel(body.output.url);
  if (rel === null) return refuse(403, NOT_FOUND);
  if (typeProblem(rel, body.output, body.op)) return refuse(400, "Invalid result");
  const poster = body.output.meta?.poster;
  if (poster && (body.output.kind !== "video" || !contentTypeFor(filesRel(poster) ?? "").startsWith("image/"))) return refuse(400, "Invalid result");
  // A Kinetic result is the size its recipe makes (a picture's own header must say so), and is recorded with it; the clip
  // under its words is a stored video.
  let output: typeof body.output & { width?: number; height?: number } = body.output;
  if (body.op === "motion") {
    const recipe = RecipeSchema.parse(body.params?.extra?.motion);
    const size = kineticOutputSize(recipe, body.feature);
    if (imageFeature(body.feature)) {
      const real = storedImageSize(rel);
      if (!real || real.width !== size.width || real.height !== size.height) return refuse(400, "Invalid result");
    }
    const clip = recipe.layers?.video?.src;
    if (clip && !contentTypeFor(filesRel(clip) ?? "").startsWith("video/")) return refuse(400, "Invalid result");
    output = { ...body.output, ...size };
  }

  if (viewer.kind === "owner") {
    // The owner's own files only: never an account's file recorded as the owner's result.
    const named = Object.values(recipeFiles(body.params?.extra)).flat();
    const refs = [body.output.url, ...(poster ? [poster] : []), ...(body.inputs.images ?? []), ...(body.inputs.video ? [body.inputs.video] : []), ...named].filter((r) => r.startsWith("/api/files/"));
    for (const ref of refs) {
      const r = filesRel(ref);
      if (r === null || typeof fileAccount(r) === "string") return refuse(403, NOT_FOUND);
    }
    try {
      return Response.json(recordLocalGeneration({ ...body, output }), { status: 201 });
    } catch (e) {
      return refuse(422, (e as Error).message);
    }
  }

  const account = viewer.account;
  // Accounts have their own runs, not the owner's Library: what they make in the browser is recorded as one of them.
  if (fileAccount(rel) !== account.id) return refuse(403, NOT_FOUND);
  // A grade or a blend is what the page renders: a PNG picture, or an MP4 or WebM clip.
  if (body.op !== "motion" && !BROWSER_TYPES.test(contentTypeFor(rel))) return refuse(400, "Invalid result");
  // Every file it names is the account's own: its inputs, its poster, and a clip's recipe's logo, product and pictures.
  const named = body.op === "motion" ? recipeFiles(body.params?.extra) : {};
  const problem = accountInputProblem({ inputs: body.inputs, params: { extra: { ...named, ...(poster && { _poster: poster }) } } }, account.id);
  if (problem) return refuse(problem.status === 404 ? 403 : problem.status, problem.status === 404 || problem.code === "input-not-yours" ? NOT_FOUND : problem.error, { code: problem.code });
  if (!diskHasRoom()) return refuse(503, ACCOUNT_MESSAGES.diskLow);
  // A saved result is one of the account's runs: the same hourly budget.
  const bucket = `run:${account.id}`;
  const rate = hit(bucket, ACCOUNT_LIMITS.runsPerHour, 60 * 60_000);
  if (!rate.ok) return Response.json({ error: ACCOUNT_MESSAGES.runRate }, { status: 429, headers: { "Retry-After": String(rate.retryAfterS), "Cache-Control": "no-store" } });
  // The words drawn on a clip and its title (never the page's own summary of them) go through the studio's checks, and
  // are what the run keeps; a grade or a blend keeps its description, checked with its title.
  const motion = body.op === "motion";
  const prompt = motion ? shownWords(body.params?.extra, body.title) : body.prompt;
  const words = motion ? prompt : [body.prompt, body.title ?? ""].map((w) => w.trim()).filter(Boolean).join(" · ").slice(0, 2000);
  const place = account.gpu ? ("own-gpu" as const) : account.keys?.fal || account.keys?.replicate ? ("own-key" as const) : ("pool" as const);
  const checked = await moderateRun(account, { feature: body.feature, modelId: body.modelId, op: body.op, prompt: words, inputs: body.inputs }, null, "own", { kind: motion ? "video" : body.output.kind, place });
  if (!checked.ok) {
    unhit(bucket);
    return refuse(422, checked.refusal.body.error, { code: checked.refusal.body.code });
  }
  try {
    const g = runAsTenant({ kind: "account", id: account.id }, () => recordLocalGeneration({ ...body, output, prompt }));
    if (checked.checkOutputs) {
      // Held until the output check answers, as any account run's files are.
      const assetId = assetIdOf(body.output.url);
      holdForCheck(g.id, [{ ...output, ...(assetId && { assetId }) }]);
      return Response.json(getGeneration(g.id) ?? g, { status: 201 });
    }
    return Response.json(g, { status: 201 });
  } catch (e) {
    unhit(bucket);
    return refuse(422, (e as Error).message);
  }
}
