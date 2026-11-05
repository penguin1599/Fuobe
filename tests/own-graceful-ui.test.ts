import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * What an account sees around a GPU or key problem, in the browser: the check before Run in the composer (the status
 * strip's answer, never a new call to the GPU), "Run with your fal.ai key" on the tool's cloud version, and the buttons
 * a failed run's tile and Settings show (Start your pod as a link to RunPod, Check my GPU, Settings, Add credit).
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: () => {}, push: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const { gpuBeforeRun, onCloudKey, GPU_OFF_WORDS } = await import("@/lib/before-run");
const { diagnoseGpu, RUNPOD_CONSOLE_URL, withKeyAction } = await import("@/lib/diagnose");
const { getModel, getPreset } = await import("@/lib/catalog");
const { TroubleActions, TroubleDetails, autoCheckIn } = await import("@/components/gpu/trouble");

const has = (id: string) => !!getModel(id);
const render = (node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, node));

const POD = "https://abc123xyz-8188.proxy.runpod.net";
const stopped = diagnoseGpu({ stage: "status", status: 404, body: "" }, { kind: "link", url: POD });
const offline = { connected: true, mode: "link" as const, online: false, trouble: stopped };
const account = (gpu: object, keys: ("fal" | "replicate")[] = []) => ({ kind: "account" as const, gpu: gpu as typeof offline, keys, paidAllowed: true });
const fpv = getPreset("motion-fpv-drone")!;
const h3 = getModel("oss-minimax-h3")!;

describe("the check before Run", () => {
  it("shows a stopped pod's words and buttons above Generate, read from the status strip's answer", () => {
    const shown = gpuBeforeRun({ viewer: account(offline), model: h3, engine: "open", preset: fpv, has, getModel })!;
    expect(shown.words).toBe(stopped.words);
    expect(shown.words).toMatch(/^Your RunPod pod isn't running, or ComfyUI isn't on port 8188/);
    expect(shown.details).toBe(stopped.details);
    expect(shown.actions.map((a) => a.kind)).toEqual(["start-gpu", "check-gpu", "gpu-settings"]);
    expect(shown.actions[0]).toMatchObject({ label: "Start your pod", target: RUNPOD_CONSOLE_URL });
  });

  it("offers the tool's cloud version on the account's own key, an explicit button", () => {
    const withFal = gpuBeforeRun({ viewer: account(offline, ["fal"]), model: h3, engine: "open", preset: fpv, has, getModel })!;
    expect(withFal.actions.at(-1)).toEqual(withKeyAction("fal"));
    expect(withFal.actions.at(-1)?.label).toBe("Run with your fal.ai key");
    // FPV Drone's cloud versions are on fal.ai only: a Replicate token runs none of them.
    expect(gpuBeforeRun({ viewer: account(offline, ["replicate"]), model: h3, engine: "open", preset: fpv, has, getModel })!.actions.map((a) => a.kind)).not.toContain("run-with-key");
    // A studio that is open-source only: no key is offered.
    expect(gpuBeforeRun({ viewer: { ...account(offline, ["fal"]), paidAllowed: false }, model: h3, engine: "open", preset: fpv, has, getModel })!.actions.map((a) => a.kind)).not.toContain("run-with-key");
  });

  it("says nothing when the run doesn't go to the account's own GPU at a web address, or the GPU answered", () => {
    const base = { model: h3, engine: "open" as const, preset: fpv, has, getModel };
    expect(gpuBeforeRun({ ...base, viewer: account({ ...offline, online: true }) })).toBeNull();
    expect(gpuBeforeRun({ ...base, viewer: { ...account(offline), kind: "guest" } })).toBeNull();
    // This computer and a paired ComfyUI have notes of their own.
    expect(gpuBeforeRun({ ...base, viewer: account({ connected: true, mode: "computer", online: false }) })).toBeNull();
    // This studio's GPUs (hosted runs), a cloud model, a Fuobe Original on the Cloud engine.
    expect(gpuBeforeRun({ ...base, viewer: account(offline), onPool: true })).toBeNull();
    expect(gpuBeforeRun({ ...base, viewer: account(offline), model: getModel("minimax-h3"), preset: undefined })).toBeNull();
    expect(gpuBeforeRun({ ...base, viewer: account(offline), model: getModel("fuobe-soul"), engine: "cloud", preset: undefined })).toBeNull();
    // An older answer without a reason still says the GPU isn't answering, with Check my GPU.
    const bare = gpuBeforeRun({ ...base, viewer: account({ connected: true, mode: "link", online: false }) })!;
    expect(bare.words).toBe(GPU_OFF_WORDS);
    expect(bare.actions.map((a) => a.kind)).toEqual(["check-gpu", "gpu-settings"]);
  });
});

describe("Run with your key on a failed run", () => {
  it("asks for the same run on the cloud version: its model and operation there, without the open graph's settings", () => {
    const req = { feature: "video" as const, modelId: "oss-minimax-h3", presetId: "motion-fpv-drone", op: "i2v" as const, prompt: "", inputs: { images: ["/files/a.png"] }, params: { duration: 6, extra: { quality: "draft" } } };
    expect(onCloudKey(req, { modelId: "minimax-h3", op: "i2v" })).toEqual({ ...req, engine: "cloud", modelId: "minimax-h3", op: "i2v", params: { duration: 6 } });
    // A Fuobe Original: the same model, on the cloud engine, with all its settings.
    const soul = { feature: "image" as const, modelId: "fuobe-soul", prompt: "a portrait", params: { extra: { look: "x" } } };
    expect(onCloudKey(soul, { modelId: "fuobe-soul" })).toEqual({ ...soul, engine: "cloud" });
  });
});

describe("the buttons", () => {
  it("Start your pod opens RunPod in a new tab; Settings is a link; Check my GPU is a button", () => {
    const html = render(createElement(TroubleActions, { actions: stopped.actions }));
    expect(html).toContain(`href="${RUNPOD_CONSOLE_URL}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain("Start your pod");
    expect(html).toContain("Check my GPU");
    expect(html).toContain('href="/settings#your-gpu"');
  });

  it("leaves out what can't be done here, and shows at most so many", () => {
    const actions = [{ kind: "retry" as const, label: "Retry" }, withKeyAction("fal", "minimax-h3"), { kind: "pick-model" as const, label: "Pick another model" }, ...stopped.actions];
    // No run to retry, no key handler, no model picker: those buttons aren't drawn.
    const bare = render(createElement(TroubleActions, { actions }));
    expect(bare).not.toMatch(/Retry|Run with your|Pick another model/);
    const handled = render(createElement(TroubleActions, { actions, handlers: { onRetry: () => {}, onRunWithKey: () => {} }, skip: ["retry"], max: 2 }));
    expect(handled).toContain("Run with your fal.ai key");
    expect(handled).toContain("Start your pod");
    expect(handled).not.toMatch(/Retry|Check my GPU/);
    expect(render(createElement(TroubleActions, { actions: [] }))).toBe("");
  });

  it("the details line is small and only there when there is something to say", () => {
    expect(render(createElement(TroubleDetails, { details: "abc123xyz-8188.proxy.runpod.net · HTTP 404" }))).toContain("HTTP 404");
    expect(render(createElement(TroubleDetails, {}))).toBe("");
  });

  it("Settings checks again by itself with a growing wait, within the check's budget", () => {
    const start = 1_000_000;
    expect(autoCheckIn("gpu-stopped", 1, start, start)).toBe(15_000);
    expect(autoCheckIn("gpu-offline", 1, start, start)).toBe(5_000);
    expect(autoCheckIn("gpu-offline", 3, start, start)).toBe(20_000);
    // Past the budget (3 minutes for a GPU that doesn't answer), and never for what waiting can't fix.
    expect(autoCheckIn("gpu-offline", 9, start, start + 3 * 60_000)).toBeNull();
    expect(autoCheckIn("gpu-password", 1, start, start)).toBeNull();
  });
});
