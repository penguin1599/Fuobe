import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers/temp-dir";
import type { Generation } from "@/lib/catalog/types";
import { startFakeComfy, type FakeComfy } from "./helpers/fake-comfy-runner";

// MiniMax H3's 2K hand-off on a real run path (review 2 of package n7-10): the 768p draft saves its latent on the ComfyUI
// it ran on and says where; the finish loads it only from there, names the draft it waits for when it starts (so a retried
// draft is the one loaded), redraws the draft's clip when the latent is gone, and never loads one across places.
vi.setConfig({ testTimeout: 120_000 });
// Regenerate is switched off for now (REGEN_OFFERED); these tests check it as it runs once switched on.
// tests/regenerate-held.test.ts checks that every way in refuses it while it is off.
vi.mock("@/lib/catalog/regenerate", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/catalog/regenerate")>()), REGEN_OFFERED: true }));

const dir = tempDir("fuobe-regen-latent-");
process.env.FUOBE_DATA_DIR = dir;
delete process.env.FUOBE_PASSWORD;
delete process.env.COMFYUI_WHERE;

const R = await import("@/lib/catalog/regenerate");
const fake: FakeComfy = await startFakeComfy({ output: "video", delayMs: 300, loras: [R.REGEN_LORA.file, R.H3_TURBO_4STEP_LORA.file] });
process.env.COMFYUI_URL = fake.url;

const gens = await import("@/server/generations");
const cinema = await import("@/server/cinema");
const { db } = await import("@/server/db");
const { setSetting } = await import("@/server/settings");
const { comfyPlace, onOwnGpu, promptRefusal, getWorkflow } = await import("@/server/providers/comfyui");
const { readAccess, saveAccess } = await import("@/server/model-access");

beforeAll(() => setSetting("demoMode", "off"));
afterAll(async () => {
  await fake.close();
});

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const graphs = () => fake.log.filter((e) => e.path === "/prompt" && e.prompt).map((e) => e.prompt as Graph);
const has = (g: Graph, cls: string) => Object.values(g).some((n) => n.class_type === cls);
const node = (g: Graph, cls: string) => Object.values(g).find((n) => n.class_type === cls)!;
const meta = (id: string) => JSON.parse((db().prepare("SELECT external_meta_json AS m FROM generations WHERE id = ?").get(id) as { m: string | null }).m ?? "{}");

async function settle(id: string, ms = 60_000): Promise<Generation> {
  const end = Date.now() + ms;
  for (;;) {
    const g = gens.getGeneration(id)!;
    if (["succeeded", "failed", "canceled"].includes(g.status)) return g;
    if (Date.now() > end) throw new Error(`timed out: ${g.status} ${g.message ?? ""}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const twoK = (prompt: string) => gens.createGenerations({ feature: "cinema", modelId: R.H3_OPEN_MODEL, op: "t2v", prompt, params: { resolution: "2K", duration: 5 } });
const split = (made: Generation[]) => ({ draft: made.find((g) => g.modelId === R.H3_OPEN_MODEL)!, finish: made.find((g) => g.modelId === R.REGEN_MODEL)! });

/** A finished 768p draft as the runner records it (whose run, and where its latent was saved). */
function keptDraft(id: string, o: { account?: string; latentAt?: string; latent?: boolean } = {}): void {
  const now = Date.now();
  const req = { feature: "cinema", modelId: R.H3_OPEN_MODEL, op: "t2v", prompt: "x", params: { resolution: "768p", extra: o.latent === false ? {} : { latentDraft: true } }, ...(o.account && { account: o.account }) };
  db()
    .prepare(
      "INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, external_id, external_meta_json, created_at, updated_at) VALUES (?, 'cinema', ?, 'open', 'comfyui', 't2v', 'video', 'succeeded', ?, '[]', 'p', ?, ?, ?)",
    )
    .run(id, R.H3_OPEN_MODEL, JSON.stringify(req), JSON.stringify(o.latentAt ? { latentAt: o.latentAt } : {}), now, now);
}

describe("the draft keeps its latent where it ran, and the finish loads it from there", () => {
  it("on this install's ComfyUI: the draft saves under its id and says where; the finish loads that file", async () => {
    const before = graphs().length;
    const { draft, finish } = split(twoK("A lighthouse in a storm"));
    expect(await settle(finish.id)).toMatchObject({ status: "succeeded" });
    const sent = graphs().slice(before);
    const d = sent.find((g) => has(g, "MiniMaxH3ImageToVideo"))!;
    expect(has(d, "OpenH3SaveRefinedLatent")).toBe(true);
    expect(node(d, "OpenH3SaveRefinedLatent").inputs.filename_prefix).toBe(`fuobe_h3_${draft.id}`);
    expect(meta(draft.id).latentAt).toBe(`server:${fake.url}`);
    const f = sent.find((g) => has(g, "OpenH3LoadRefinedLatent"))!;
    expect(node(f, "OpenH3LoadRefinedLatent").inputs.latent_file).toBe(`fuobe_h3_${draft.id}_00001.safetensors`);
    expect(gens.getGeneration(finish.id)!.request.params?.extra?.latentFrom).toBe(draft.id);
  });

  it("redraws the draft's clip when the latent is gone from that ComfyUI, in the same run", async () => {
    fake.opts.refuseClass = "OpenH3LoadRefinedLatent";
    try {
      const before = graphs().length;
      const { finish } = split(twoK("A harbour at dawn"));
      expect(await settle(finish.id)).toMatchObject({ status: "succeeded" });
      const sent = graphs().slice(before);
      expect(sent.filter((g) => has(g, "OpenH3LoadRefinedLatent"))).toHaveLength(1);
      const clip = sent.find((g) => has(g, "OpenH3RegenPrepareDraft"))!;
      expect(has(clip, "LoadVideo")).toBe(true);
    } finally {
      fake.opts.refuseClass = undefined;
    }
  });

  it("a Cinema retry of a failed draft finishes the new draft, from its own latent", async () => {
    fake.opts.refuseClass = "MiniMaxH3ImageToVideo";
    const project = cinema.createProject({ name: "Storm" });
    const made = twoK("A cliff in the rain");
    cinema.recordTakes(project.id, made, null);
    const first = split(made);
    expect(await settle(first.draft.id)).toMatchObject({ status: "failed" });
    expect(await settle(first.finish.id)).toMatchObject({ status: "failed" });
    fake.opts.refuseClass = undefined;
    const before = graphs().length;
    const again = split(cinema.retryItem(project.id, first.finish.id));
    expect(again.draft.id).not.toBe(first.draft.id);
    expect(again.finish.request.finishOf).toBe(again.draft.id);
    expect(await settle(again.finish.id)).toMatchObject({ status: "succeeded" });
    expect(gens.getGeneration(again.finish.id)!.request.params?.extra?.latentFrom).toBe(again.draft.id);
    const f = graphs().slice(before).find((g) => has(g, "OpenH3LoadRefinedLatent"))!;
    expect(node(f, "OpenH3LoadRefinedLatent").inputs.latent_file).toBe(`fuobe_h3_${again.draft.id}_00001.safetensors`);
  });
});

describe("where a latent may be loaded from", () => {
  it("names the ComfyUI a job goes to; the owner's workers keep nothing between jobs", () => {
    expect(comfyPlace()).toBe(`server:${fake.url}`);
    expect(onOwnGpu({ url: "https://gpu.example/" }, () => comfyPlace())).toBe("link:https://gpu.example");
    expect(onOwnGpu({ kind: "computer", principal: "acct:a1" }, () => comfyPlace())).toBe("computer:acct:a1");
    setSetting("comfyWhere", "computer");
    try {
      expect(comfyPlace()).toBe("computer:owner");
      setSetting("comfyWhere", "workers");
      expect(comfyPlace()).toBeNull();
    } finally {
      setSetting("comfyWhere", "server");
    }
  });

  it("loads only a latent this run's owner kept on this same ComfyUI, and keeps a draft's only where it stays", () => {
    const here = `server:${fake.url}`;
    keptDraft("ownHere00001", { latentAt: here });
    keptDraft("ownThere0001", { latentAt: "server:http://other-comfy.test:8188" });
    keptDraft("acctDraft001", { latentAt: here, account: "acct-x" });
    keptDraft("plainDraft01", { latentAt: here, latent: false });
    const ask = (latentFrom: string, account?: string) => gens.latentHandOff({ latentFrom, startSigma: 0.8 }, account)?.latentFrom;
    expect(ask("ownHere00001")).toBe("ownHere00001");
    // Another ComfyUI, a run that didn't keep one, one that doesn't exist.
    expect(ask("ownThere0001")).toBeUndefined();
    expect(ask("plainDraft01")).toBeUndefined();
    expect(ask("nope")).toBeUndefined();
    // Another's run: the owner's for an account, an account's for the owner or another account.
    expect(ask("ownHere00001", "acct-x")).toBeUndefined();
    expect(ask("acctDraft001")).toBeUndefined();
    expect(ask("acctDraft001", "acct-y")).toBeUndefined();
    // The same ComfyUI reached as an account's link is another place.
    expect(onOwnGpu({ url: fake.url }, () => ask("acctDraft001", "acct-x"))).toBeUndefined();
    // On the owner's workers neither a draft's latent nor a finish from one: each job's output folder is emptied.
    setSetting("comfyWhere", "workers");
    try {
      expect(gens.latentHandOff({ latentDraft: true, latentFrom: "ownHere00001" }, undefined)).toEqual({});
    } finally {
      setSetting("comfyWhere", "server");
    }
    expect(gens.latentHandOff({ latentDraft: true }, undefined)).toEqual({ latentDraft: true });
    // The Turbo 4-step LoRA switched off: the draft runs on H3's own graph.
    const was = readAccess();
    saveAccess({ ...was, loras: [...was.loras, R.H3_TURBO_4STEP_LORA.file] });
    try {
      expect(gens.latentHandOff({ latentDraft: true }, undefined)).toEqual({});
    } finally {
      saveAccess(was);
    }
  });

  it("says a missing latent in plain words, and the next finish redraws the clip", () => {
    const { manifest } = getWorkflow(R.REGEN_LATENT_WORKFLOW);
    const body = { error: { type: "prompt_outputs_failed_validation" }, node_errors: { "1": { class_type: "OpenH3LoadRefinedLatent", errors: [{ message: "Value not in list", extra_info: { input_name: "latent_file", received_value: "fuobe_h3_x_00001.safetensors" } }] } } };
    const words = promptRefusal(body, 400, manifest, []).message!;
    expect(words).toBe(R.REGEN_COPY.latentGone);
    expect(words).not.toMatch(/safetensors|OpenH3|latent_file|fuobe_h3/);
    // Another graph's refusal keeps ComfyUI's own words.
    expect(promptRefusal(body, 400, getWorkflow(R.REGEN_WORKFLOW).manifest, []).message).not.toBe(R.REGEN_COPY.latentGone);
    keptDraft("goneDraft001", { latentAt: `server:${fake.url}` });
    expect(gens.latentHandOff({ latentFrom: "goneDraft001" }, undefined)?.latentFrom).toBe("goneDraft001");
    const now = Date.now();
    db()
      .prepare(
        "INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, error, created_at, updated_at) VALUES ('goneFinish01', 'cinema', ?, 'open', 'comfyui', 'upscale-video', 'video', 'failed', ?, '[]', ?, ?, ?)",
      )
      .run(R.REGEN_MODEL, JSON.stringify({ feature: "cinema", modelId: R.REGEN_MODEL, params: { extra: { latentFrom: "goneDraft001" } } }), R.REGEN_COPY.latentGone, now, now);
    expect(gens.latentHandOff({ latentFrom: "goneDraft001" }, undefined)?.latentFrom).toBeUndefined();
  });
});
