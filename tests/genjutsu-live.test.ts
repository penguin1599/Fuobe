import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GENJUTSU_FEATURE_KEYS, GENJUTSU_FEATURES } from "@/lib/catalog/genjutsu";
import { genjutsuLive } from "@/server/genjutsu-live";
import { tempDir } from "./helpers/temp-dir";

// Genjutsu's Openjutsu features open to everyone one by one: each needs its workflows accepted by ComfyUI AND a real render
// recorded as passed (workflows/comfyui/gpu-tested.json). The manifest flag alone never opens one.
const ROOT = process.cwd();
const dir = tempDir("fuobe-genjutsu-live-");
const write = (name: string, v: unknown) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v));
  return f;
};
const all = [...new Set(Object.values(GENJUTSU_FEATURES).flatMap((f) => f.workflows))];

describe("Genjutsu's live gate", () => {
  it("needs both: workflows validated and a passed render", () => {
    const validated = write("m-ok.json", { workflows: all.map((id) => ({ id, validated: true })) });
    const notValidated = write("m-no.json", { workflows: all.map((id) => ({ id, validated: false })) });
    const passed = write("r-ok.json", { features: Object.fromEntries(GENJUTSU_FEATURE_KEYS.map((k) => [k, { passed: true }])) });
    const none = write("r-none.json", { features: {} });
    expect(Object.values(genjutsuLive(validated, none)).some(Boolean)).toBe(false);
    expect(Object.values(genjutsuLive(notValidated, passed)).some(Boolean)).toBe(false);
    expect(Object.values(genjutsuLive(validated, passed)).every(Boolean)).toBe(true);
    // One feature at a time.
    const one = write("r-one.json", { features: { "finish-colours": { passed: true, date: "2026-11-03" }, "finish-faces": { passed: false } } });
    const live = genjutsuLive(validated, one);
    expect(live["finish-colours"]).toBe(true);
    expect(live["finish-faces"]).toBe(false);
    expect(live.picture).toBe(false);
    // From picture needs all three of its workflows.
    const partly = write("m-part.json", { workflows: all.map((id) => ({ id, validated: id !== "video-scene-describe" })) });
    expect(genjutsuLive(partly, passed).picture).toBe(false);
    expect(genjutsuLive(partly, passed)["finish-colours"]).toBe(true);
  });

  it("a missing file, a missing entry or bad JSON opens nothing", () => {
    const validated = write("m2.json", { workflows: all.map((id) => ({ id, validated: true })) });
    expect(Object.values(genjutsuLive(validated, path.join(dir, "missing.json"))).some(Boolean)).toBe(false);
    expect(Object.values(genjutsuLive(path.join(dir, "missing.json"), write("r2.json", { features: { picture: { passed: true } } }))).some(Boolean)).toBe(false);
    expect(Object.values(genjutsuLive(validated, write("bad.json", "{not json"))).some(Boolean)).toBe(false);
  });

  it("the committed record opens only the features that passed, and the page passes the gate to the studio", () => {
    const record = JSON.parse(fs.readFileSync(path.join(ROOT, "workflows/comfyui/gpu-tested.json"), "utf8")) as { features: Record<string, { passed: boolean }> };
    expect(Object.keys(record.features).sort()).toEqual(["clean-voice-first", "finish-colours", "group-swap", "group-swap-one-by-one", "original-sound", "picture-h3-renderer"]);
    expect(Object.entries(genjutsuLive()).filter(([, on]) => on).map(([k]) => k).sort()).toEqual(["finish-colours", "group-swap", "group-swap-one-by-one", "picture-h3-renderer"]);
    const page = fs.readFileSync(path.join(ROOT, "src/app/(studio)/genjutsu/page.tsx"), "utf8");
    expect(page).toContain("const live = genjutsuLive();");
    // The page's mode examples are only the ones open to everyone (the owner's come from an owner-only route).
    expect(page).toMatch(/<GenjutsuStudio examples=\{exampleRow\("tool:genjutsu"\)\} modeExamples=\{genjutsuExamples\(\(f\) => live\[f\]\)\} live=\{live\} \/>/);
    // The studio shows a feature when it is live, the viewer is the owner, or it runs on a visitor's own GPU until then
    // (src/lib/own-setup.ts); its mark ("Only you", or what it runs on) shows until it is live.
    const studio = fs.readFileSync(path.join(ROOT, "src/components/genjutsu/genjutsu-studio.tsx"), "utf8");
    expect(studio).toContain("const open: FeatureCheck = useCallback((f) => owner || !!live?.[f] || !!ownSetupItem(`genjutsu:${f}`), [owner, live]);");
    expect(studio).toContain("const mark = (f: GenjutsuFeature): React.ReactNode => (live?.[f] ? undefined : owner ? <OnlyYou /> : <OwnSetupChip setup={ownSetupItem(`genjutsu:${f}`)} />);");
  });
});
