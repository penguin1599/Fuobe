import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers/temp-dir";

vi.mock("server-only", () => ({}));

/**
 * Image to 3D's extra steps on a visitor's own GPU (Refine detail with Hi3D, the TRELLIS.2 final, Idol 3D's other sides
 * and its spike trim): they show to guests and accounts, each labelled with what it runs on until its graphs are
 * validated on this studio's GPU, and the label leaves by itself once the manifest says so. The owner's view is today's.
 */

// Who is looking: the client hooks the studio reads, set per test.
const who = vi.hoisted(() => ({ owner: false, viewer: { kind: "guest" } as { kind: "guest" | "account"; gpu?: { connected: boolean }; keys?: string[] } | undefined }));
vi.mock("@/lib/api", () => ({
  useIsOwner: () => who.owner,
  useStatus: () => ({ data: who.owner ? {} : { viewer: who.viewer } }),
  useEngine: () => ["open", () => {}, "both"],
  useModelAccess: () => undefined,
  useGenerations: () => ({ data: [] }),
  askToSignUp: vi.fn(),
  CONNECT_GPU_EVENT: "fuobe:connect-gpu",
}));
vi.mock("@/components/keys/your-keys", () => ({ openAddKey: vi.fn() }));
vi.mock("@/components/model3d/hooks", () => ({
  useCreate3d: () => ({ mutate: vi.fn(), isPending: false }),
  useRunPreview: () => ({ data: undefined }),
  priceLine: () => null,
}));

const BANNED = /untested|not tested|unverified|not verified|not validated|validat|isn['’]t available|not available|unavailable|coming soon|held|owner|beta|experimental|soon/i;
const IDS = ["image-to-3d:hi3d-refine", "image-to-3d:trellis-final", "image-to-3d:idol-other-sides", "image-to-3d:idol-clean"] as const;
const GRAPHS: Record<(typeof IDS)[number], string> = {
  "image-to-3d:hi3d-refine": "mesh-refine-hi3d",
  "image-to-3d:trellis-final": "image-to-3d-trellis2",
  "image-to-3d:idol-other-sides": "image-to-views-idol",
  "image-to-3d:idol-clean": "image-to-splat-idol-clean",
};

const d = tempDir("fuobe-own-setup-3d-");
const manifest = (validated: Partial<Record<string, boolean>>) => {
  const file = path.join(d, `m-${Object.values(validated).join("-")}-${Object.keys(validated).length}.json`);
  fs.writeFileSync(file, JSON.stringify({ workflows: Object.entries(validated).map(([id, v]) => ({ id, validated: v })) }));
  return file;
};

afterEach(() => {
  who.owner = false;
  who.viewer = { kind: "guest" };
});

describe("Image to 3D's extra steps: the labels follow the manifest", () => {
  it("each step has a setup of its own and plain words", async () => {
    const { MODEL3D_SETUPS } = await import("@/lib/av/model3d");
    const { ownSetupOnly, ownSetupLabel, ownSetupShort, ownSetupDetail, ownSetupGraphs } = await import("@/lib/own-setup");
    expect(Object.values(MODEL3D_SETUPS).sort()).toEqual([...IDS].sort());
    for (const id of IDS) {
      const o = ownSetupOnly(id);
      expect(o, id).not.toBeNull();
      expect(ownSetupGraphs(id), id).toEqual([GRAPHS[id]]);
      for (const words of [ownSetupLabel(o!), ownSetupShort(o!), ownSetupDetail(o!)]) expect(words, id).not.toMatch(BANNED);
    }
    expect(ownSetupLabel(ownSetupOnly("image-to-3d:hi3d-refine")!)).toBe("Runs on your own GPU · 24 GB");
    expect(ownSetupLabel(ownSetupOnly("image-to-3d:idol-other-sides")!)).toBe("Runs on your own GPU · 8 GB");
  });

  it("keeps a step's label until its graph is validated, then drops it", async () => {
    const { ownSetupsNow } = await import("@/server/own-setup-live");
    const before = ownSetupsNow(IDS, manifest(Object.fromEntries(Object.values(GRAPHS).map((g) => [g, false]))));
    for (const id of IDS) expect(before[id], id).not.toBeNull();
    // One flag flips: only that step's label leaves.
    const one = ownSetupsNow(IDS, manifest({ ...Object.fromEntries(Object.values(GRAPHS).map((g) => [g, false])), "mesh-refine-hi3d": true }));
    expect(one["image-to-3d:hi3d-refine"]).toBeNull();
    expect(one["image-to-3d:idol-other-sides"]).not.toBeNull();
    const after = ownSetupsNow(IDS, manifest(Object.fromEntries(Object.values(GRAPHS).map((g) => [g, true]))));
    for (const id of IDS) expect(after[id], id).toBeNull();
    // No manifest: every label stays (never a step shown as if this studio's GPU ran it).
    const none = ownSetupsNow(IDS, path.join(d, "missing.json"));
    for (const id of IDS) expect(none[id], id).not.toBeNull();
    // An id with no graphs of its own keeps ownSetupOnly's answer; one outside the table has none.
    expect(ownSetupsNow(["oss-h3-regenerate", "nano-banana-pro"], manifest({}))).toEqual({ "oss-h3-regenerate": expect.objectContaining({ need: "gpu" }), "nano-banana-pro": null });
  });

  it("reads this repo's manifest: a step labelled now is one whose graph isn't validated yet", async () => {
    const { ownSetupsNow } = await import("@/server/own-setup-live");
    const m = JSON.parse(fs.readFileSync(path.join(process.cwd(), "workflows", "comfyui", "manifest.json"), "utf8")) as { workflows: { id: string; validated?: boolean }[] };
    const validated = new Set(m.workflows.filter((w) => w.validated === true).map((w) => w.id));
    const now = ownSetupsNow(IDS);
    for (const id of IDS) expect(now[id] === null, id).toBe(validated.has(GRAPHS[id]));
  });
});

/** Renders a step under the page's setups, as the given viewer. */
async function render(node: () => ReactNode, setups: Record<string, unknown>) {
  const { Model3dSetupsProvider } = await import("@/components/model3d/own-setups");
  return renderToStaticMarkup(createElement(Model3dSetupsProvider, { value: setups }, node()));
}

describe("Image to 3D's extra steps show to everyone", () => {
  it("Refine detail and Make the other sides show to a guest and an account with their labels, and to the owner without", async () => {
    const { ownSetupOnly } = await import("@/lib/own-setup");
    const { RefineOption } = await import("@/components/model3d/refine-option");
    const { OtherSides } = await import("@/components/model3d/other-sides");
    const setups = { refine: ownSetupOnly("image-to-3d:hi3d-refine"), sides: ownSetupOnly("image-to-3d:idol-other-sides") };
    const refine = () => createElement(RefineOption, { engine: "open", value: null, onChange: () => {}, openAllowed: true, onUseGpu: () => {} });
    const sides = () => createElement(OtherSides, { photo: "/api/files/front.png", asPhoto: true, label: "Make the other sides from the front (Idol 3D)", onMade: () => {} });
    for (const viewer of [{ kind: "guest" as const }, { kind: "account" as const, gpu: { connected: false } }]) {
      who.viewer = viewer;
      const r = await render(refine, setups);
      expect(r).toContain("Refine detail · Hi3D 1.0");
      expect(r).toContain('data-slot="own-setup"');
      expect(r).toContain("Runs on your own GPU · 24 GB");
      const s = await render(sides, setups);
      expect(s).toContain("Make the other sides from the front (Idol 3D)");
      expect(s).toContain("Runs on your own GPU · 8 GB");
      for (const html of [r, s]) expect(html.replace(/<[^>]+>/g, " ")).not.toMatch(BANNED);
    }
    // Once the graphs are validated (the page passes null), the steps show with no label.
    const r = await render(refine, { refine: null, sides: null });
    expect(r).toContain("Refine detail · Hi3D 1.0");
    expect(r).not.toContain('data-slot="own-setup"');
    // The owner's view is today's: the step, no label.
    who.owner = true;
    const o = await render(refine, setups);
    expect(o).toContain("Refine detail · Hi3D 1.0");
    expect(o).not.toContain('data-slot="own-setup"');
  });

  it("Make the other sides is offered to visitors too (a visitor's run goes to its own GPU)", async () => {
    const { useOtherSidesOffered } = await import("@/components/model3d/other-sides");
    let offered: boolean | undefined;
    const Probe = () => {
      offered = useOtherSidesOffered();
      return null;
    };
    for (const viewer of [{ kind: "guest" as const }, { kind: "account" as const }]) {
      who.viewer = viewer;
      offered = undefined;
      renderToStaticMarkup(createElement(Probe));
      expect(offered).toBe(true);
    }
  });

  it("a press: a guest gets the sign-up card, an account without a GPU the connect card, one with a GPU and the owner run", async () => {
    const { ownSetupOnly, ownSetupStep } = await import("@/lib/own-setup");
    for (const id of IDS) {
      const o = ownSetupOnly(id);
      expect(ownSetupStep(o, { kind: "guest" })).toEqual({ kind: "sign-up" });
      expect(ownSetupStep(o, { kind: "account", gpu: { connected: false }, keys: ["fal"] })).toEqual({ kind: "connect-gpu", gpuOnly: true });
      expect(ownSetupStep(o, { kind: "account", gpu: { connected: true } })).toEqual({ kind: "run" });
      expect(ownSetupStep(o, null)).toEqual({ kind: "run" });
    }
  });
});
