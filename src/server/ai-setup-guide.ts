import "server-only";
import { FIRST_MODEL_FITS, FIRST_MODEL_NAME, FIRST_MODEL_WORKFLOW, FIRST_PICTURE_MODELS } from "@/lib/ai-setup/first-picture";
import type { GuideModel } from "@/lib/ai-setup/guide";
import { loadManifest } from "./providers/comfyui";

/** The first picture models' files, from the workflow manifest, for the guide's "Get a first picture model" (no gated files). */
export function guideModels(): GuideModel[] {
  const workflows = loadManifest().workflows;
  return FIRST_PICTURE_MODELS.flatMap((m) => {
    const wf = workflows.find((w) => w.id === FIRST_MODEL_WORKFLOW[m]);
    if (!wf || wf.models.some((f) => f.gated && !f.optional)) return [];
    const files = wf.models.filter((f) => f.url && !f.optional).map((f) => ({ file: f.file, folder: f.folder, url: f.url!, sizeGb: f.sizeGb ?? 0 }));
    return files.length ? [{ name: FIRST_MODEL_NAME[m], fits: FIRST_MODEL_FITS[m], files }] : [];
  });
}
