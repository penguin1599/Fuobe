import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Generation } from "@/lib/catalog/types";
import { startFakeComfy, TINY_MP4, type FakeComfy } from "./helpers/fake-comfy-runner";

// MiniMax H3's 2K hand-off under public sign-up (review 3 of package n7-10): which saved 768p latent a finish loads is the
// server's to say. A client can't name one (POST /api/generations drops latentFrom and latentDraft), and a run inside the
// server loads one only from a run of the same account that kept it on the same ComfyUI: never the owner's or another
// account's, even when both sit on one ComfyUI. An account's own 2K run hands its latent over on its own GPU.
vi.setConfig({ testTimeout: 120_000 });
// Regenerate is switched off for now (REGEN_OFFERED); these tests check it as it runs once switched on.
// tests/regenerate-held.test.ts checks that every way in refuses it while it is off.
vi.mock("@/lib/catalog/regenerate", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/catalog/regenerate")>()), REGEN_OFFERED: true }));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fuobe-account-latent-"));
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://owner-comfy.test:8188";
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_ALLOW_PRIVATE_URLS;
delete process.env.FUOBE_HOSTED_RUNS;
globalThis.__fuobeTestDiskFree = 1e13;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
  return new Response("not stubbed", { status: 599 });
}) as typeof fetch;

const R = await import("@/lib/catalog/regenerate");
const auth = await import("@/server/auth");
const { POST } = await import("@/app/api/generations/route");
const gens = await import("@/server/generations");
const { saveFile } = await import("@/server/storage");
const { db } = await import("@/server/db");
const { resetRates } = await import("@/server/rate");
const { comfyPlace } = await import("@/server/providers/comfyui");

let fake: FakeComfy;
let a = "";
let b = "";
let cookie = "";
let place = "";
beforeAll(async () => {
  fake = await startFakeComfy({ output: "video", delayMs: 300, loras: [R.REGEN_LORA.file, R.H3_TURBO_4STEP_LORA.file] });
  globalThis.__fuobeTestGpuPort = fake.port;
  auth.setPassword("install password");
  a = auth.createAccount("latent-a@example.com", "long enough").id;
  b = auth.createAccount("latent-b@example.com", "long enough").id;
  auth.setAccountGpu(a, { url: fake.url });
  auth.setAccountGpu(b, { url: fake.url });
  cookie = `${auth.SESSION_COOKIE}=${auth.createSession(a).value}`;
  place = gens.asAccount(a, () => comfyPlace())!;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  globalThis.__fuobeTestGpuPort = undefined;
  globalThis.__fuobeTestDiskFree = undefined;
  await fake.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});
beforeEach(() => {
  resetRates();
  // Each test's runs count alone toward the account's active-run limit.
  db().prepare("UPDATE generations SET status = 'canceled' WHERE status IN ('queued', 'running')").run();
});

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const graphs = () => fake.log.filter((e) => e.path === "/prompt" && e.prompt).map((e) => e.prompt as Graph);
const has = (g: Graph, cls: string) => Object.values(g).some((n) => n.class_type === cls);
const loaded = (g: Graph) => Object.values(g).find((n) => n.class_type === "OpenH3LoadRefinedLatent")?.inputs.latent_file;

function run(body: unknown) {
  const text = JSON.stringify(body);
  return POST(
    new Request("http://localhost:3000/api/generations", {
      method: "POST",
      headers: { cookie, host: "localhost:3000", "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) },
      body: text,
    }),
  );
}

/** Wait until the runner has sent this run's graph to the account's ComfyUI (or it stopped), and return that graph. */
async function sentFor(id: string, from: number): Promise<Graph> {
  const end = Date.now() + 60_000;
  for (;;) {
    const g = gens.getGeneration(id)!;
    const sent = graphs().slice(from);
    if (sent.length && (g.status !== "queued" || g.message === "Queued")) return sent[sent.length - 1];
    if (g.status === "failed") throw new Error(`failed: ${g.error}`);
    if (Date.now() > end) throw new Error(`nothing sent: ${g.status} ${g.message ?? ""}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function settle(id: string): Promise<Generation> {
  const end = Date.now() + 60_000;
  for (;;) {
    const g = gens.getGeneration(id)!;
    if (["succeeded", "failed", "canceled"].includes(g.status)) return g;
    if (Date.now() > end) throw new Error(`timed out: ${g.status} ${g.message ?? ""}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** A finished 768p draft that kept its latent on `latentAt` (whose: an account's, or the owner's). */
function keptDraft(id: string, account: string | undefined, latentAt: string): void {
  const now = Date.now();
  const req = { feature: "video", modelId: R.H3_OPEN_MODEL, op: "t2v", prompt: "x", params: { resolution: "768p", extra: { latentDraft: true } }, ...(account && { account }) };
  db()
    .prepare(
      "INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, external_id, external_meta_json, created_at, updated_at) VALUES (?, 'video', ?, 'open', 'comfyui', 't2v', 'video', 'succeeded', ?, '[]', 'p', ?, ?, ?)",
    )
    .run(id, R.H3_OPEN_MODEL, JSON.stringify(req), JSON.stringify({ latentAt }), now, now);
}

const clipOf = (accountId: string) => saveFile({ data: TINY_MP4, contentType: "video/mp4", name: "clip.mp4", source: "upload", accountId }).url;
const finishOf = (video: string, latentFrom: string) => ({
  feature: "video",
  modelId: R.REGEN_MODEL,
  op: "upscale-video" as const,
  prompt: "A lighthouse in a storm",
  inputs: { video },
  params: { resolution: "1440p", numOutputs: 1, extra: { startSigma: 0.8, draftFrom: "h3", latentFrom } },
});

describe("an account's 2K finish and saved latents", () => {
  it("a client can't name a latent or keep one: the API drops both, and the clip is redrawn", async () => {
    keptDraft("ownerDraft01", undefined, place);
    const before = graphs().length;
    const r = await run({ ...finishOf(clipOf(a), "ownerDraft01"), params: { resolution: "1440p", extra: { startSigma: 0.8, draftFrom: "h3", latentFrom: "ownerDraft01", latentDraft: true } } });
    expect(r.status).toBe(201);
    const { items } = (await r.json()) as { items: Generation[] };
    expect(items[0].request).toMatchObject({ account: a, modelId: R.REGEN_MODEL });
    expect(items[0].request.params?.extra).toEqual({ startSigma: 0.8, draftFrom: "h3" });
    const g = await sentFor(items[0].id, before);
    expect(has(g, "OpenH3LoadRefinedLatent")).toBe(false);
    expect(has(g, "LoadVideo")).toBe(true);
  });

  it("inside the server too: a finish loads only its own account's latent, never the owner's or another account's", async () => {
    keptDraft("ownerDraft02", undefined, place);
    keptDraft("acctBDraft01", b, place);
    keptDraft("acctADraft01", a, place);
    const tryFrom = async (latentFrom: string) => {
      const before = graphs().length;
      const [g] = gens.asAccount(a, () => gens.createGenerations(finishOf(clipOf(a), latentFrom)));
      expect(g.request.account).toBe(a);
      return sentFor(g.id, before);
    };
    for (const theirs of ["ownerDraft02", "acctBDraft01"]) {
      const g = await tryFrom(theirs);
      expect(has(g, "OpenH3LoadRefinedLatent"), theirs).toBe(false);
      expect(has(g, "LoadVideo"), theirs).toBe(true);
    }
    expect(loaded(await tryFrom("acctADraft01"))).toBe("fuobe_h3_acctADraft01_00001.safetensors");
  });

  it("an account's own 2K run keeps its latent on its own GPU, and its finish loads it there", async () => {
    const before = graphs().length;
    const r = await run({ feature: "video", modelId: R.H3_OPEN_MODEL, op: "t2v", prompt: "A lighthouse in a storm", params: { resolution: "2K", duration: 5 } });
    expect(r.status).toBe(201);
    const { items } = (await r.json()) as { items: Generation[] };
    const draft = items.find((g) => g.modelId === R.H3_OPEN_MODEL)!;
    const finish = items.find((g) => g.modelId === R.REGEN_MODEL)!;
    for (const g of items) expect(g.request.account).toBe(a);
    expect(await settle(finish.id)).toMatchObject({ status: "succeeded" });
    const meta = JSON.parse((db().prepare("SELECT external_meta_json AS m FROM generations WHERE id = ?").get(draft.id) as { m: string }).m);
    expect(meta.latentAt).toBe(place);
    expect(place).toBe(`link:${fake.url}`);
    const sent = graphs().slice(before);
    expect(sent.some((g) => has(g, "MiniMaxH3ImageToVideo") && has(g, "OpenH3SaveRefinedLatent"))).toBe(true);
    expect(sent.map(loaded).filter(Boolean)).toEqual([`fuobe_h3_${draft.id}_00001.safetensors`]);
  });
});
