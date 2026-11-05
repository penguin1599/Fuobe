import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRESET_ICONS } from "@/components/preset-icons";
import { getModel, MODELS, PRESETS } from "@/lib/catalog";
import { onEngine } from "@/lib/catalog/engines";
import type { Manifest } from "@/lib/comfy";

describe("catalog integrity", () => {
  it("has unique model and preset ids", () => {
    const ids = MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    const pids = PRESETS.map((p) => p.id);
    expect(new Set(pids).size).toBe(pids.length);
  });

  it("every model has routes and sane defaults", () => {
    for (const m of MODELS) {
      expect(m.routes.length, m.id).toBeGreaterThan(0);
      const d = m.defaults ?? {};
      if (d.aspectRatio && m.options.aspectRatios) expect(m.options.aspectRatios, `${m.id} aspect`).toContain(d.aspectRatio);
      if (d.resolution && m.options.resolutions) expect(m.options.resolutions, `${m.id} resolution`).toContain(d.resolution);
      // ComfyUI, the WorldCast worker, browser-only tools and Ollama-only text steps are the open engine; every API provider is cloud.
      // A Fuobe Original runs on both: each engine it lists has routes, and every route is on one of them.
      const engines = m.engines ?? [m.engine];
      for (const r of m.routes) {
        const open = r.provider === "comfyui" || r.provider === "worldcast" || r.provider === "local" || (r.provider === "llm" && r.endpoint === "ollama");
        expect(engines, `${m.id} engine/provider`).toContain(open ? "open" : "cloud");
      }
      if (m.engines) {
        expect(m.engines, m.id).toContain(m.engine);
        for (const e of m.engines) expect(onEngine(m, e).routes.length, `${m.id} on ${e}`).toBeGreaterThan(0);
      }
    }
  });

  it("every preset points at an existing model that supports its operation", () => {
    for (const p of PRESETS) {
      for (const route of [p.cloud, p.open]) {
        if (!route) continue;
        const m = getModel(route.modelId);
        expect(m, `${p.id} → ${route.modelId}`).toBeDefined();
        expect(m!.routes.some((r) => r.op === route.op), `${p.id}: ${route.modelId} can't ${route.op}`).toBe(true);
      }
      expect(p.cloud ?? p.open, `${p.id} has no route`).toBeTruthy();
      expect(PRESET_ICONS[p.look.icon], `${p.id} icon ${p.look.icon}`).toBeDefined();
    }
  });

  it("every ComfyUI route has a workflow in the manifest (when the library exists)", () => {
    const file = path.join(process.cwd(), "workflows/comfyui/manifest.json");
    if (!fs.existsSync(file)) return;
    const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
    const ids = new Set(manifest.workflows.map((w) => w.id));
    // "{n}" routes pick a workflow per clip count (join clips: 2, 3 or 4).
    const expand = (e: string) => (e.includes("{n}") ? ["2", "3", "4"].map((n) => e.replace("{n}", n)) : [e]);
    const missing = MODELS.flatMap((m) =>
      m.routes.filter((r) => r.provider === "comfyui").flatMap((r) => expand(r.endpoint).filter((e) => !ids.has(e)).map((e) => `${m.id}:${e}`)),
    );
    expect(missing).toEqual([]);
  });
});
