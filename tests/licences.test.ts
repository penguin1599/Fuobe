import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MODELS } from "@/lib/catalog";
import type { Manifest } from "@/lib/comfy";
import { buildLicenceList, kindLabel, licenceTerms, NODE_PACKS, UNKNOWN_LICENCE, workflowLicence } from "@/lib/licences";

/** The About & licences page (R4-53): every open model's licence, its catches and notices. */

const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "workflows", "comfyui", "manifest.json"), "utf8")) as Manifest;
const wf = (id: string) => manifest.workflows.find((w) => w.id === id) ?? { id };
const terms = (id: string) => licenceTerms(workflowLicence(wf(id)));

describe("licences", () => {
  it("knows the licence of every workflow in the library", () => {
    const unknown = manifest.workflows.filter((w) => workflowLicence(w) === UNKNOWN_LICENCE).map((w) => w.id);
    expect(unknown).toEqual([]);
  });

  it("flags non-commercial weights and code, but not a variant Fuobe keeps away from", () => {
    for (const id of ["v2a-mmaudio", "style-ref-uso-flux1", "captions-whisper-burnin", "flux1-dev-t2i", "flux2-dev-t2i", "face-swap-reactor", "flux1-kontext-dev-edit"]) {
      expect(terms(id).flags, id).toContain("non-commercial");
    }
    // "DA3-LARGE / GIANT are CC-BY-NC, do not swap them in": the graph uses the Apache-2.0 one.
    for (const id of ["video-depth-da3", "video-depth-vda-small", "bg-remove-rmbg", "z-image-turbo-t2i", "wan22-t2v-14b"]) {
      expect(terms(id).flags, id).not.toContain("non-commercial");
    }
  });

  it("reads every capitalised or leading NC mention in the manifest as non-commercial", () => {
    // Any other lower-case mention must name a variant the graph doesn't use; list it here when one is added.
    const variants = new Set(["video-depth-da3", "video-depth-vda-small", "bg-remove-rmbg"]);
    for (const w of manifest.workflows) {
      const text = workflowLicence(w);
      // The FLUX Kommunity License (FLUX 3 Image Klein) is non-commercial with a revenue tier: Qualifying Users below US$5M
      // may sell outputs, so it reads as a licence with conditions.
      if (/Kommunity License/.test(text)) {
        expect(licenceTerms(text).flags, w.id).toEqual(["conditions"]);
        continue;
      }
      if (!/non-commercial|CC-BY-NC/i.test(text) || variants.has(w.id)) continue;
      expect(licenceTerms(text).flags, w.id).toContain("non-commercial");
    }
  });

  it("names the countries a licence leaves out, and the conditions of community licences", () => {
    expect(terms("hunyuan15-t2v-720p")).toMatchObject({ flags: ["territory"], excludes: "the EU, UK and South Korea" });
    expect(terms("sfx-hunyuan-foley").flags).toEqual(["territory"]);
    for (const id of ["ltx25-t2v", "style-ref-krea2", "sfx-stable-audio-3-small", "tts-indextts2", "sdxl-t2i"]) expect(terms(id).flags, id).toEqual(["conditions"]);
    expect(terms("bg-remove-birefnet").flags).toEqual([]);
    expect(terms("video-trim")).toMatchObject({ flags: [], noWeights: true });
  });

  it("finds the notices a licence asks the app to show", () => {
    expect(terms("image-to-splat-triposplat").notices).toEqual(["Built with DINOv3"]);
    expect(terms("hidream-i1-dev-t2i").notices).toEqual(["Built with Llama"]);
    expect(licenceTerms('MIT; the app must show a "Built with X" notice').notices).toEqual(["Built with X"]);
  });

  it("lists every open catalog model once, in or out of the weights list", () => {
    const list = buildLicenceList(MODELS, manifest.workflows);
    const open = MODELS.filter((m) => m.routes.some((r) => r.provider === "comfyui") && !m.id.startsWith("oss-selftest"));
    const listed = new Set([...list.rows.filter((r) => r.inCatalog).map((r) => r.name), ...list.noWeights]);
    for (const m of open) expect(listed.has(m.name), m.id).toBe(true);
    expect(list.rows.find((r) => r.id === "oss-flux2-dev")).toMatchObject({ workflows: ["flux2-dev-t2i", "flux2-dev-multiref"], flags: ["non-commercial"] });
    // Join clips names a family of workflows (video-concat-{n}); none of them has weights.
    expect(list.noWeights).toContain("Join clips");
    // Library workflows without weights are only counted (their titles are long descriptions).
    expect(list.noWeights.every((n) => MODELS.some((m) => m.name === n))).toBe(true);
    expect(list.noWeightsLibrary).toBeGreaterThan(0);
    expect(list.rows.some((r) => r.id.startsWith("selftest"))).toBe(false);
    // Workflows no studio uses yet are listed after the catalog's models.
    const firstLibrary = list.rows.findIndex((r) => !r.inCatalog);
    expect(list.rows.slice(firstLibrary).every((r) => !r.inCatalog)).toBe(true);
    expect(list.counts.all).toBe(list.rows.length);
    expect(list.counts.clear + list.counts["non-commercial"] + list.counts.territory + list.counts.conditions).toBeGreaterThanOrEqual(list.rows.length);
  });

  it("names kinds and capabilities in words", () => {
    expect([kindLabel("model3d"), kindLabel("scene-3d"), kindLabel("ocr"), kindLabel("remove-object")]).toEqual(["3D", "Scene 3D", "OCR", "Remove object"]);
  });

  it("collects notices with the models that need them", () => {
    const list = buildLicenceList(MODELS, manifest.workflows);
    expect(list.notices.find((n) => n.text === "Built with Llama")?.models).toEqual(["HiDream-I1 Dev"]);
    expect(list.notices.find((n) => n.text === "Built with DINOv3")?.models.length).toBeGreaterThan(0);
    // TripoSplat (also inside Any Angle), Idol 3D, Pixal3D and TRELLIS.2 (single and multi-view) encode with DINOv3; without them, no notice.
    expect(list.notices.find((n) => n.text === "Built with DINOv3")?.models).toEqual(expect.arrayContaining(["TripoSplat", "Idol 3D", "Pixal3D", "TRELLIS.2", "TRELLIS.2 Multi-view"]));
    const without = buildLicenceList(MODELS, manifest.workflows.filter((w) => !/triposplat|idol|trellis2|pixal3d|any-angle/.test(w.id)));
    expect(without.notices.some((n) => n.text === "Built with DINOv3")).toBe(false);
  });

  it("links each licence to where it can be read, as Models & licences does", () => {
    const list = buildLicenceList(MODELS, manifest.workflows);
    for (const r of list.rows) expect(r.links.length, r.id).toBe(r.licences.length);
    const linked = list.rows.flatMap((r) => r.links).filter(Boolean).length;
    // Every licence the KNOWN table names has its own page; the rest link to the model card of their largest download.
    expect(linked / list.rows.flatMap((r) => r.links).length).toBeGreaterThan(0.9);
    expect(list.rows.find((r) => r.id === "oss-flux2-dev")?.links).toEqual(["https://huggingface.co/black-forest-labs/FLUX.2-dev"]);
    expect(list.rows.find((r) => r.workflows.includes("bg-remove-birefnet"))?.links[0]).toBe("https://spdx.org/licenses/MIT.html");
    // Without the downloads, a licence with no page of its own has no link.
    const bare = buildLicenceList(MODELS, manifest.workflows.map((w) => ({ ...w, models: undefined })));
    expect(bare.rows.flatMap((r) => r.links).filter(Boolean).length).toBeLessThanOrEqual(linked);
  });

  it("node pack notes, which everyone can read, name no install switches or scripts", () => {
    const said = NODE_PACKS.map((p) => `${p.name}: ${p.licence.note ?? ""}`).filter((n) => /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+=|scripts\/|install-[a-z-]+\.sh/.test(n));
    expect(said).toEqual([]);
  });
});
